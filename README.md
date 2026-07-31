# Markdown-Browser

I wanted to read my Markdown notebooks in a web browser.  I typically use VS Code and view using Markdown-preview-enhanced extension.
This extension uses Crossnote as the Markdown renderer, and for which I have provided a few markdown and style enhancements.

Other tools I found didn't use this library, and or did a lesser job, though some of them were awesome.  So I vibe coded a node.js solution
to browse the files.

## Start it...

```bash
npm start -- {path to MD files} [Port]
```

Default port is 3000

