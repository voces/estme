# estme

**Emoji Sheep Tag Model Editor** - A vector graphics editor for creating and animating models for [Emoji Sheep Tag](https://github.com/voces/emoji-sheep-tag/).

## Live Demo

https://voces.github.io/estme/

## Features

- Vector path editing with bezier curves
- Hierarchical grouping and z-ordering
- Keyframe animation with transform properties (translate, rotate, scale, opacity)
- Reference image support (paste images as guides)
- SVG import
- Export to binary format for use in Emoji Sheep Tag
- Autosave with IndexedDB storage

## Development

Requires [Deno](https://deno.land/).

```bash
# Start dev server
deno task dev

# Build for production
deno task build
```

## About

This project was entirely written by [Claude Code](https://claude.ai/claude-code).
