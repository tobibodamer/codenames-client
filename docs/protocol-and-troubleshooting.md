# Codenames Protocol, Adjustments & Troubleshooting Guide

This document records the exact reverse-engineered protocol mechanisms of [codenames.game](https://codenames.game), all adjustments made to get this client working with the live backend, and diagnostic steps for whenever the upstream service changes.

---

## 1. Upstream Architecture & Connection Flow

The live Codenames service runs on Google Kubernetes Engine (GKE):
- **Base server**: `https://server-discord.gke.codenames.game`
- **Supported game types**:
  - `cnduet` (Codenames Duet)
  - `cno2` (Classic Codenames)
- **Transport**: Socket.IO over WebSockets (`transports: ['websocket']`).

### Room Creation vs. Joining Protocol

```
+----------------+                +-------------------------+               +------------------+
| Client (Host)  |                | Lobby Server (Base URL) |               | Shard Server (/1)|
+----------------+                +-------------------------+               +------------------+
        |                                      |                                      |
        |--- 1. Connect to /{gameName} ------->|                                      |
        |--- 2. emit('sync', 'default', null, -|                                      |
        |       creds, { roomID: null }) ----->|                                      |
        |                                      |                                      |
        |<-- 3. 'createdMatch'(roomID, matchID,|                                      |
        |       playerID, creds, shardURL) ----|                                      |
        |                                      |                                      |
        |--- 4. Disconnect from Lobby ------------------------------------------------|
        |--- 5. Connect to Shard socket.io (path: /{shard}/socket.io) --------------->|
        |--- 6. emit('sync', matchID, playerID, creds, { roomID }) ------------------>|
        |<-- 7. 'sync'(matchID, syncState) -------------------------------------------|
        |                                                                             |
+----------------+                                                                    |
| Client (Guest) |                                                                    |
+----------------+                                                                    |
        |--- 8. Connect to Lobby with known roomID ---------------------------------->|
        |<-- 9. Redirection / updateServerURL(shardURL) or direct shard connection ---|
        |--- 10. emit('sync', 'default', null, creds, { roomID: 'slug' }) ------------>|
        |<-- 11. 'joinedMatch' & 'sync' on shard -------------------------------------|
```

1. **Creating a Room**:
   - `roomID` **must be `null` or `undefined`**.
   - Client sends initial `sync` with `matchID: "default"`, `playerID: null`, `roomID: null`.
   - The lobby allocates a 2-word slug (e.g. `potaz-zuvaj`), match ID, sets player 0 as host, and sends `createdMatch` with `shardURL` (e.g. `https://server-discord.gke.codenames.game/1`).
   - The client reconnects to the shard using path prefix `/{shard}/socket.io` (e.g. `/1/socket.io`) and namespace `/{gameName}`.

2. **Joining a Room**:
   - Client supplies the host's `roomID` slug (e.g. `potaz-zuvaj`).
   - Lobby either redirects to the shard via `createdMatch` / `updateServerURL` or assigns player ID (`1`, `2`, ...).

---

## 2. Issues Encountered & All Adjustments Made

### Issue 1: Room Creation Blocked by Default `generateRoomId()`
- **Symptom**: Calling `createCodenamesProvider()` without a `roomID` resulted in `sync-error: "match not found"`. Rooms could never be created.
- **Root Cause**: `createProviderConfig` and `provider.start()` defaulted `roomID` to `generateRoomId()`. The lobby server only allocates a room if `roomID` is absent or null; if an arbitrary string is passed, the lobby looks for an existing match with that slug and returns `match not found`.
- **Files Modified**:
  - [`src/types.ts`](../src/types.ts): Made `roomID?: string | null` optional in `CodenamesClientOptions` and `CNProviderConfig`.
  - [`src/provider.ts`](../src/provider.ts): Changed default `roomID` to `undefined` in `createProviderConfig` and removed `roomID: generateRoomId()` fallback in `start()`.
  - [`src/transport/CodenamesSocketIO.ts`](../src/transport/CodenamesSocketIO.ts): Ensured `meta.roomID` emits `this.roomID || null`.

### Issue 2: Premature Sync During Shard Relocation
- **Symptom**: Reconnection to the game shard failed or hung when creating matches.
- **Root Cause**: On `createdMatch`, `CodenamesTransport` immediately called `this.notifyClient(...)`, which called `updateCreatedMatch(...)` on `ClientImpl`. That immediately called `this.requestSync()` on the old lobby socket before `updateServerURL(serverURL)` had disconnected and reconnected to the new shard socket.
- **Files Modified**:
  - [`src/transport/CodenamesSocketIO.ts`](../src/transport/CodenamesSocketIO.ts):
    - Added `seatingInProgress` flag during `createdMatch` dispatch.
    - Updated `updateServerURL` to return a `boolean` indicating if a reconnect was triggered.
    - Only triggered `requestSync()` if `updateServerURL` returned `false` (no shard change).

### Issue 3: RFC 6902 JSON Patch `MissingError` Crash Loops
- **Symptom**: Game state updates crashed or triggered constant resync loops after moves.
- **Root Cause**: The live backend sends delta patches with `remove` operations targeting non-existent or server-internal paths (e.g. `/plugins/log/data/metadata`). The official browser bundle uses `fast-json-patch` with `validateOperation = false` (silent ignore). In Node.js, `boardgame.io` uses strict `rfc6902`, which throws `MissingError` if attempting to `remove` a path that doesn't exist, failing the patch.
- **Files Modified**:
  - [`src/client.ts`](../src/client.ts): Added `sanitizedPatch` filtering in `receiveTransportData('patch')` to drop `remove` operations on paths that do not exist in the current store state before dispatching to `rfc6902`.

### Issue 4: Inverted Role Validation in Classic Codenames (`cno2`)
- **Symptom**: Calling `client.joinTeam('red', 'spymasters')` in Classic mode always failed with `Invalid role parameter: spymasters`.
- **Root Cause**: In [`src/game/classic/CNDiscordGame.ts`](../src/game/classic/CNDiscordGame.ts), the validation was written as:
  ```ts
  if (!role || !(env.G.teams as any)[role]?.[team] !== undefined)
  ```
  Because `!(env.G.teams as any)[role]?.[team]` evaluated to `false`, and `false !== undefined` is `true`, the condition was always `true` for all valid roles.
- **Files Modified**:
  - [`src/game/classic/CNDiscordGame.ts`](../src/game/classic/CNDiscordGame.ts): Fixed condition to:
    ```ts
    if (!role || (env.G.teams as any)[role]?.[team] === undefined)
    ```

### Issue 5: Credential Formatting & Shallow Options Merging
- **Symptom**: Connecting without explicit credentials resulted in invalid sync handshakes or silent rejects.
- **Root Cause**:
  1. `createCodenamesProvider({ clientOpts: { playerName: '...' } })` shallowly replaced `clientOpts`, discarding `base.clientOpts.credentials`.
  2. Fallback to `nanoid()` produced strings containing uppercase letters and underscores, which the server validator rejects.
  3. `multiplayer({ ...opts })` in `client.ts` passed `credentials` from raw arguments instead of `this.credentials`.
- **Files Modified**:
  - [`src/provider.ts`](../src/provider.ts): Deep-merged `clientOpts` ignoring `undefined` entries.
  - [`src/client.ts`](../src/client.ts): Replaced `nanoid()` credential fallback with `generateCredentials()` (syllabic format: `word-word-word`), and passed `credentials: this.credentials` to `multiplayer()`.

### Issue 6: Subscriber ID Collisions in `ClientImpl`
- **Symptom**: Subscribing and unsubscribing listeners (e.g., during `waitForSync`) could silently overwrite existing listeners.
- **Root Cause**: `subscribe()` used `Object.keys(this.subscribers).length` as keys, leading to duplicate keys when entries were deleted.
- **Files Modified**:
  - [`src/client.ts`](../src/client.ts): Replaced length-based IDs with an auto-incrementing `subscriberCounter`.

### Issue 7: Client Ergonomics & Move Convenience
- **Additions**:
  - `client.waitForSync(timeoutMs)`: Waits for the client to establish full synchronization with the live server.
  - `client.roomID`, `client.matchID`, `client.credentials` getters.
  - Optional `player` argument in `giveClue`, `guessCard`, `endGuessing`, `addSuggestion`, and `likeSuggestionToggle` (defaults to `this.currentPlayer`).

---

## 3. How to Check If Something Changed on Codenames.game

Whenever the backend service updates or behavior appears broken, run the automated test suite:

```bash
# Run all live integration tests
npm test

# Run Duet tests only
npm run test:duet

# Run Classic tests only
npm run test:classic

# Run the standalone example
npm run example
```

### What the Tests Verify
- **Room Creation**: Checks if the lobby URL is alive and allocates room slugs and player `0`.
- **Shard Redirection**: Checks if shard socket paths (`/{shard}/socket.io`) and websocket handshakes connect.
- **Guest Join**: Checks if multi-player join by room code functions.
- **Team Selection**:
  - Duet: `side1` and `side2`.
  - Classic: `red` and `blue` for `spymasters` and `operatives`.
- **Match Deal**: Checks if `startMatch` with 25 words transitions phase to `game` and properly shuffles/deals the grid.
- **Live In-Game Moves**:
  - Card tips (`tipCard`) sync between players.
  - Clue submission (`giveClue`) switches active role/team.
  - Card guessing (`guessCard`) updates card reveal status.
  - Ending turns (`endGuessing`) switches roles and updates timer tokens.

---

## 4. Troubleshooting Checklist (If Tests Fail in the Future)

If `npm test` fails in the future, follow this checklist to identify what changed:

| Symptom | Likely Cause | Investigation Step |
|---|---|---|
| `ETIMEDOUT` or connection refused on `server-discord.gke.codenames.game` | Host domain or shard endpoint changed | Open browser DevTools on [codenames.game](https://codenames.game), check Network tab -> WS filter for the current Socket.IO host URL. Update `serverURL` in `src/provider.ts`. |
| `sync-error: "match not found"` on room create | Lobby protocol changed how match creation is requested | Check initial `sync` emit payload. Ensure `matchID: 'default'` and `roomID: null` are still used. |
| Tests time out waiting for `phase === 'game'` | `startMatch` payload format changed | Inspect WebSocket frames when clicking "Start Game" in the official web client. Check if `word`, `packSize`, `packName`, `packType`, `mix` format changed. |
| `MissingError` in console | New server plugin or patch format | Look at incoming `patch` payloads in `src/client.ts`. Add new transient path prefixes to `sanitizedPatch`. |
| `Invalid role parameter` or `INVALID_MOVE` on moves | Rule/move signature changed upstream | Check `CNDuetGame.ts` or `CNDiscordGame.ts` against the latest bundled game JS in the browser client. |
