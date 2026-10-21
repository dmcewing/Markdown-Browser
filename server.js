const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Notebook } = require('crossnote');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const WATCH_DEBOUNCE_MS = 200;

function escapeHtml(input) {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeNotePath(input) {
  return input.replaceAll('\\', '/');
}

function shouldHideFolder(folderName) {
  return folderName.startsWith('.');
}

function encodePathSegments(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isMarkdownFile(fileName) {
  return /\.(md|markdown|mdown|mkdn|mkd|rmd|qmd|mdx)$/i.test(fileName);
}

function safeResolve(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    return null;
  }
  return target;
}

async function collectMarkdownFiles(rootDir) {
  const output = [];
  const visitedRealDirs = new Set();

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        const targetStat = await fs.promises.stat(fullPath).catch(() => null);
        if (!targetStat) continue; // broken symlink
        isDir = targetStat.isDirectory();
        isFile = targetStat.isFile();
      }

      if (isDir) {
        if (shouldHideFolder(entry.name)) continue;

        if (entry.isSymbolicLink()) {
          const realDir = await fs.promises.realpath(fullPath);
          if (visitedRealDirs.has(realDir)) continue; // prevent symlink cycles
          visitedRealDirs.add(realDir);
        }

        await walk(fullPath);
      } else if (isFile && isMarkdownFile(entry.name)) {
        const rel = path.relative(rootDir, fullPath);
        output.push(normalizeNotePath(rel));
      }
    }
  }

  await walk(rootDir);
  output.sort((a, b) => a.localeCompare(b));
  return output;
}

function buildNoteTree(noteFiles) {
  const root = { folders: new Map(), files: [] };

  for (const file of noteFiles) {
    const parts = file.split('/');
    let cursor = root;
    let skipFile = false;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;

      if (isLast) {
        if (!skipFile) {
          cursor.files.push(file);
        }
        continue;
      }

      if (shouldHideFolder(part)) {
        skipFile = true;
        break;
      }

      if (!cursor.folders.has(part)) {
        cursor.folders.set(part, { folders: new Map(), files: [] });
      }
      cursor = cursor.folders.get(part);
    }
  }

  return root;
}

function renderTreeNode(node, parentPath, currentNotePath) {
  const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) => a.localeCompare(b));
  let html = '<ul class="tree-level">';

  for (const folderName of folderNames) {
    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    const isOpen = currentNotePath === folderPath || currentNotePath.startsWith(`${folderPath}/`);
    const child = node.folders.get(folderName);
    html += `<li class="tree-folder"><details${isOpen ? ' open' : ''}><summary>${escapeHtml(folderName)}</summary>${renderTreeNode(child, folderPath, currentNotePath)}</details></li>`;
  }

  for (const file of files) {
    const label = escapeHtml(path.posix.basename(file));
    const href = `/note/${encodePathSegments(file)}`;
    const activeClass = file === currentNotePath ? 'tree-note active' : 'tree-note';
    html += `<li class="tree-file"><a class="${activeClass}" href="${href}" target="_top">${label}</a></li>`;
  }

  html += '</ul>';
  return html;
}

function getDefaultNotePath(noteFiles) {
  const rootReadme = noteFiles.find((file) => /^readme\.md$/i.test(file));
  return rootReadme || noteFiles[0] || '';
}

function renderShellPage(noteFiles, selectedNotePath, notebookTitle, sidebarHeaderHtml) {
  const currentNotePath = selectedNotePath || getDefaultNotePath(noteFiles);
  const treeHtml = renderTreeNode(buildNoteTree(noteFiles), '', currentNotePath);
  const initialContentPath = currentNotePath ? `/content/${encodePathSegments(currentNotePath)}` : '';
  const contentHtml = initialContentPath
    ? `<iframe class="content-frame" src="${initialContentPath}" title="Markdown notebook content"></iframe>`
    : '<div class="empty-state">No markdown files found.</div>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(notebookTitle)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --sidebar-bg: #ffffff;
        --line: #d0d7de;
        --text: #1f2328;
        --muted: #656d76;
        --link: #0b5fff;
        --active-bg: #eaf2ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Segoe UI, sans-serif;
        color: var(--text);
        background: var(--bg);
      }
      .app {
        display: grid;
        grid-template-columns: 320px 1fr;
        min-height: 100vh;
      }
      .sidebar {
        border-right: 1px solid var(--line);
        background: var(--sidebar-bg);
        overflow: auto;
        padding: 1rem;
      }
      .sidebar h1 {
        margin: 0 0 0.75rem;
        font-size: 1.1rem;
      }
      .sidebar .hint {
        margin: 0 0 0.75rem;
        color: var(--muted);
        font-size: 0.85rem;
      }
      .tree-level {
        margin: 0;
        padding-left: 1rem;
        list-style: none;
      }
      .tree-level:first-child {
        padding-left: 0;
      }
      .tree-folder > details > summary {
        cursor: pointer;
        padding: 0.2rem 0.1rem;
        user-select: none;
      }
      .tree-file a {
        display: inline-block;
        padding: 0.18rem 0.35rem;
        border-radius: 6px;
        color: var(--link);
        text-decoration: none;
      }
      .tree-file a:hover {
        text-decoration: underline;
      }
      .tree-file a.active {
        background: var(--active-bg);
        color: #08367e;
        text-decoration: none;
      }
      .content-wrap {
        min-width: 0;
      }
      .content-frame {
        width: 100%;
        height: 100vh;
        border: 0;
        background: #ffffff;
      }
      .empty-state {
        display: grid;
        place-items: center;
        height: 100vh;
        color: var(--muted);
        font-size: 1rem;
      }
      @media (max-width: 900px) {
        .app {
          grid-template-columns: 1fr;
        }
        .sidebar {
          max-height: 45vh;
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
        .content-frame,
        .empty-state {
          height: 55vh;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <nav class="sidebar" aria-label="Notebook tree">
        ${sidebarHeaderHtml}
        <p class="hint">Folders can be expanded and collapsed.</p>
        ${treeHtml}
      </nav>
      <main class="content-wrap">
        ${contentHtml}
      </main>
    </div>
  </body>
</html>`;
}

function renderIndexPage(noteFiles, notebookTitle, sidebarHeaderHtml) {
  return renderShellPage(noteFiles, null, notebookTitle, sidebarHeaderHtml);
}

async function loadSidebarHeaderHtml(notebookPath, notebook, notebookTitle) {
  const infoPath = path.join(notebookPath, '.crossnote', 'info.md');
  const infoStat = await fs.promises.stat(infoPath).catch(() => null);
  if (!infoStat || !infoStat.isFile()) {
    return `<h1>${escapeHtml(notebookTitle)}</h1>`;
  }

  const infoMarkdown = await fs.promises.readFile(infoPath, 'utf8');
  const rendered = notebook.renderMarkdown(infoMarkdown, { isForPreview: false });
  return `<div class="notebook-info">${rendered}</div>`;
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendFile(res, filePath) {
  if (path.extname(filePath).toLowerCase() === '.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => sendText(res, 500, 'Failed to read file'));
  stream.pipe(res);
}

async function main() {
  const notebookArg = process.argv[2] || process.env.NOTEBOOK_PATH;
  const portArg = process.argv[3] || process.env.PORT;

  if (!notebookArg) {
    console.error('Usage: npm start -- <notebook-folder> [port]');
    process.exit(1);
  }

  const notebookPath = path.resolve(process.cwd(), notebookArg);
  const notebookTitle = path.basename(notebookPath);
  const stat = await fs.promises.stat(notebookPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error(`Notebook folder does not exist: ${notebookPath}`);
    process.exit(1);
  }

  const port = Number.parseInt(portArg || String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid port: ${portArg}`);
    process.exit(1);
  }

  const notebook = await Notebook.init({
    notebookPath,
    config: {
      previewTheme: 'github-light.css',
      codeBlockTheme: 'github.css',
      mathRenderingOption: 'KaTeX',
      enableScriptExecution: false,
      enableEmojiSyntax: true,
      enableExtendedTableSyntax: true,
      frontMatterRenderingOption: 'code'
    },
  });

  let noteFiles = await collectMarkdownFiles(notebookPath);
  let sidebarHeaderHtml = await loadSidebarHeaderHtml(notebookPath, notebook, notebookTitle);
  let refreshTimer = null;
  let refreshing = false;
  let needsRefresh = false;

  const refreshNoteIndex = async (reason) => {
    if (refreshing) {
      needsRefresh = true;
      return;
    }

    refreshing = true;
    try {
      noteFiles = await collectMarkdownFiles(notebookPath);
      sidebarHeaderHtml = await loadSidebarHeaderHtml(notebookPath, notebook, notebookTitle);
      console.log(`Notebook index refreshed (${noteFiles.length} files): ${reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to refresh notebook index: ${message}`);
    } finally {
      refreshing = false;
      if (needsRefresh) {
        needsRefresh = false;
        queueRefresh('batched file events');
      }
    }
  };

  const queueRefresh = (reason) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshNoteIndex(reason);
    }, WATCH_DEBOUNCE_MS);
  };

  const watcher = fs.watch(notebookPath, { recursive: true }, (eventType, changedPath) => {
    const changed = changedPath ? normalizeNotePath(String(changedPath)) : '[unknown path]';
    const isCrossnoteMetadata = changed.startsWith('.crossnote/');
    if (changed !== '[unknown path]' && !isMarkdownFile(changed) && !isCrossnoteMetadata) {
      return;
    }
    queueRefresh(`${eventType}: ${changed}`);
  });

  watcher.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Watcher error: ${message}`);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendText(res, 400, 'Bad request');
        return;
      }

      const url = new URL(req.url, `http://${HOST}:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/' || pathname === '/index.html') {
        sendHtml(res, 200, renderIndexPage(noteFiles, notebookTitle, sidebarHeaderHtml));
        return;
      }

      if (pathname.startsWith('/note/')) {
        const relativeNotePath = normalizeNotePath(pathname.slice('/note/'.length));
        const absoluteNotePath = safeResolve(notebookPath, relativeNotePath);
        if (!absoluteNotePath) {
          sendText(res, 403, 'Forbidden');
          return;
        }

        const fileStat = await fs.promises.stat(absoluteNotePath).catch(() => null);
        if (!fileStat || !fileStat.isFile() || !isMarkdownFile(relativeNotePath)) {
          sendText(res, 404, 'Note not found');
          return;
        }

        sendHtml(res, 200, renderShellPage(noteFiles, relativeNotePath, notebookTitle, sidebarHeaderHtml));
        return;
      }

      if (pathname.startsWith('/assets/')) {
        const rel = pathname.replace(/^\/assets\//, '');
        const fullPath = safeResolve(notebookPath, rel);
        if (!fullPath) {
          sendText(res, 403, 'Forbidden');
          return;
        }
        const fileStat = await fs.promises.stat(fullPath).catch(() => null);
        if (!fileStat || !fileStat.isFile()) {
          sendText(res, 404, 'Asset not found');
          return;
        }
        sendFile(res, fullPath);
        return;
      }

      if (pathname.startsWith('/content/')) {
        const relativeNotePath = normalizeNotePath(pathname.slice('/content/'.length));
        const absoluteNotePath = safeResolve(notebookPath, relativeNotePath);
        if (!absoluteNotePath) {
          sendText(res, 403, 'Forbidden');
          return;
        }

        const fileStat = await fs.promises.stat(absoluteNotePath).catch(() => null);
        if (!fileStat || !fileStat.isFile()) {
          sendText(res, 404, 'Note not found');
          return;
        }

        if (!isMarkdownFile(relativeNotePath)) {
          sendFile(res, absoluteNotePath);
          return;
        }

        const engine = notebook.getNoteMarkdownEngine(relativeNotePath);
        const markdown = await fs.promises.readFile(absoluteNotePath, 'utf8');
        const parsed = await engine.parseMD(markdown, {
          useRelativeFilePath: true,
          isForPreview: false,
          hideFrontMatter: false,
          fileDirectoryPath: path.dirname(absoluteNotePath),
        });
        const html = await engine.generateHTMLTemplateForExport(parsed.html, parsed.yamlConfig, {
          isForPrint: false,
          isForPrince: false,
          offline: false,
          embedLocalImages: false,
          isForBrowser: true,
        });

        sendHtml(res, 200, html);
        return;
      }

      sendText(res, 404, 'Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendText(res, 500, `Server error: ${message}`);
    }
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`Notebook: ${notebookPath}`);
    console.log(`Listening: ${url}`);
    
    // Open browser
    const command = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(command, (err) => {
      if (err) {
        console.warn(`Failed to open browser: ${err.message}`);
      }
    });
  });

  const shutdown = (signal) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    watcher.close();
    server.close(() => {
      console.log(`Server stopped after ${signal}`);
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
