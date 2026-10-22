# Changelog

All notable adjustments to reverse-engineered protocol handling and client functionality.

## [0.1.1] - 2026-10-15

### Fixed
- **Room Creation Protocol**: Made `roomID` optional. Omitted/null `roomID` now signals match creation to the lobby server, preventing `match not found` errors caused by arbitrary `generateRoomId()` slugs.
- **Shard Reconnection Synchronization**: Prevented premature `requestSync()` calls during `createdMatch` prior to completing shard socket connection.
- **RFC 6902 JSON Patch Sanitization**: Filtered out `remove` patch operations targeting non-existent paths (such as `/plugins/log/data/metadata`) to avoid `MissingError` crashes in `boardgame.io`.
- **Classic Role Assignment**: Fixed inverted boolean condition in `CNDiscordGame.ts` (`!(env.G.teams as any)[role]?.[team] !== undefined`) that previously blocked all `joinTeam` moves in Classic mode.
- **Credentials Handling**: Deep-merged `clientOpts` in `createCodenamesProvider()` to prevent discarding default credentials, and replaced `nanoid()` fallbacks with valid syllabic `generateCredentials()` tokens.
- **Subscriber ID Generator**: Changed `subscribers` map keys in `ClientImpl` from length-based keys to an auto-incrementing counter, preventing listener overwrites upon unsubscribe.

### Added
- **`waitForSync(timeoutMs)`**: Added method to `CodenamesClient` to await full game state synchronization.
- **State Getters**: Exposed `roomID`, `matchID`, and `credentials` on `CodenamesClient`.
- **Ergonomic In-Game Moves**: Allowed omitting `player` in `giveClue`, `guessCard`, `endGuessing`, `addSuggestion`, and `likeSuggestionToggle`, defaulting to `this.currentPlayer`.
- **Automated Test Suite**: Added live integration test suite under `test/`:
  - `npm test`: Runs both Classic and Duet live tests sequentially with `--test-concurrency=1`.
  - `npm run test:duet`: Runs Codenames Duet test suite.
  - `npm run test:classic`: Runs Classic Codenames test suite.
- **Documentation**: Added `docs/protocol-and-troubleshooting.md` with complete connection diagrams, technical explanations of each fix, and a checklist for future protocol changes.
