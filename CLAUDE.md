# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # compile TypeScript → dist/
npm run dev          # watch mode (tsc --watch)
npm run example      # build + run src/example.ts (accepts room ID as first CLI arg)
```

There is no test runner configured.

## Architecture

This is a TypeScript client library for [codenames.game](https://codenames.game). It wraps a custom fork of [boardgame.io](https://boardgame.io/) and exposes a high-level API for two game variants: **Codenames Duet** (`cnduet`) and **Classic Codenames** (`cno2`).

### Layer stack (top → bottom)

| Layer | File | Purpose |
|-------|------|---------|
| Public API | `src/CodenamesClient.ts` | High-level moves + RxJS observables |
| Provider | `src/provider.ts` | Manages client lifecycle; reactive `ProviderState` |
| Low-level client | `src/client.ts` | Redux store + boardgame.io middleware (`ClientImpl`) |
| Transport | `src/transport/CodenamesSocketIO.ts` | Custom Socket.IO transport with codenames-specific events |
| Game definitions | `src/game/duet/CNDuetGame.ts`, `src/game/classic/CNDiscordGame.ts` | boardgame.io `Game` configs (moves, phases, playerView) |
| Derived state | `src/helpers.ts` | `computeDerivedState` — master selector over raw `ClientState` |
| Types | `src/types.ts` | All shared TypeScript types |

### How to connect

The recommended entry point is `createCodenamesProvider()` (`src/provider.ts`). It creates a `CodenamesProvider` that manages the underlying `ClientImpl` lifecycle via RxJS `switchMap`. When `gameName` changes, the old client is torn down and a new one is started automatically.

`CodenamesClient` (`src/CodenamesClient.ts`) is a thin wrapper over `ClientImpl` that exposes named move methods and RxJS streams. It is instantiated from the `client` field of `ProviderState`.

See `src/example.ts` for a minimal usage example.

### Key conventions

- Player team membership is stored under `G.teams` as `{ [playerKey: string]: true }` where `playerKey = "p#" + playerID`.
- Duet teams are `side1` / `side2` (flat structure); Classic teams are `red` / `blue` × `operatives` / `spymasters` (nested).
- `computeDerivedState` in `src/helpers.ts` is the single place where UI-facing computed values (phase flags, `playerAction`, board indices, etc.) are derived. Pass the full provider state to get a `DerivedState` object.
- The boardgame.io server URL for the live service is `https://server-discord.gke.codenames.game`. The transport connects to `{server}/{gameName}` as the Socket.IO namespace.
- The transport handles shard-switching: the server can redirect clients to a different URL via `updateServerURL` or `wrongNamespace` socket events.

### `reference/` folder

Contains extracted JS bundle fragments and WebSocket dump JSON files used during reverse-engineering. Gitignored entirely — not part of the build, not importable.
