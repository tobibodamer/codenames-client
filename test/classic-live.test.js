const { test } = require('node:test');
const assert = require('node:assert');
const {
  SAMPLE_WORDS,
  createAndConnectClient,
  waitForState
} = require('./helpers');

test('Classic Codenames (cno2) live integration test', async (t) => {
  let hostProvider;
  let hostClient;
  let guestProvider;
  let guestClient;

  t.after(() => {
    try { hostClient?.disconnect(); } catch (_) {}
    try { hostProvider?.stop(); } catch (_) {}
    try { guestClient?.disconnect(); } catch (_) {}
    try { guestProvider?.stop(); } catch (_) {}
  });

  await t.test('1. Host creates a Classic room (cno2)', async () => {
    const res = await createAndConnectClient({
      gameName: 'cno2',
      playerName: 'RedSpymaster'
    });
    hostProvider = res.provider;
    hostClient = res.client;

    assert.ok(hostClient.isConnected, 'Host should be connected');
    assert.strictEqual(hostClient.playerID, '0');
    assert.ok(hostClient.roomID);
    assert.strictEqual(hostClient.state?.gameName, 'cno2');
    assert.strictEqual(hostClient.state?.ctx?.phase, 'lobby');
  });

  await t.test('2. Guest joins Classic room', async () => {
    const res = await createAndConnectClient({
      gameName: 'cno2',
      playerName: 'RedOperative',
      roomID: hostClient.roomID
    });
    guestProvider = res.provider;
    guestClient = res.client;

    assert.ok(guestClient.isConnected, 'Guest should be connected');
    assert.strictEqual(guestClient.playerID, '1');
    assert.strictEqual(guestClient.roomID, hostClient.roomID);
  });

  await t.test('3. Players join Classic roles (spymaster and operative)', async () => {
    hostClient.joinTeam('red', 'spymasters');
    guestClient.joinTeam('red', 'operatives');

    await waitForState(
      hostClient,
      s => s.G?.teams?.red?.spymasters?.['p#0'] && s.G?.teams?.red?.operatives?.['p#1'],
      10000,
      'classic team roles in host state'
    );

    await waitForState(
      guestClient,
      s => s.G?.teams?.red?.spymasters?.['p#0'] && s.G?.teams?.red?.operatives?.['p#1'],
      10000,
      'classic team roles in guest state'
    );

    assert.strictEqual(hostClient.state.G.teams.red.spymasters['p#0'], true);
    assert.strictEqual(guestClient.state.G.teams.red.operatives['p#1'], true);
  });

  await t.test('4. Host starts Classic match', async () => {
    hostClient.startMatch(SAMPLE_WORDS);

    await waitForState(
      hostClient,
      s => s.ctx?.phase === 'game' && Array.isArray(s.G?.grid) && s.G.grid.length === 25,
      15000,
      'phase === "game" on host'
    );

    await waitForState(
      guestClient,
      s => s.ctx?.phase === 'game' && Array.isArray(s.G?.grid) && s.G.grid.length === 25,
      15000,
      'phase === "game" on guest'
    );

    assert.strictEqual(hostClient.state.ctx.phase, 'game');
    assert.strictEqual(guestClient.state.ctx.phase, 'game');
    assert.strictEqual(hostClient.state.G.grid.length, 25);
    assert.ok(['red', 'blue'].includes(hostClient.state.G.startingTeam), 'Starting team should be red or blue');
    assert.strictEqual(hostClient.state.G.activeRole, 'spymasters');
  });
});
