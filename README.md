# SubZeroDev Adventures

Play deterministic story campaigns in your browser, built on
[SubZeroDev Game Engine](https://github.com/The-Running-Dev/SubZeroDev.GameEngine).

**Live:** https://adventures.subzerodev.com/

## Development

```bash
npm install     # builds the engine submodule (git submodule) as part of `prepare`
npm run dev
```

See [`CLAUDE.md`](CLAUDE.md) for the engine submodule contract, campaign content generation,
and how to regenerate the visual-regression baselines.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Production build to `dist/` |
| `npm run check` | The full local gate: format, lint, typecheck, unit tests, real-browser tests, build |
| `npm run setup` | Build the engine submodule (`engine/src/engine`) — needed after a fresh clone or a submodule bump |
| `npm run sync:campaigns` | Regenerate `public/campaigns/` from the pinned engine submodule |

## Credit

The engine, its determinism guarantees, and every campaign's story content live in
[SubZeroDev.GameEngine](https://github.com/The-Running-Dev/SubZeroDev.GameEngine). This repo
is the standalone player for it.
