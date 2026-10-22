const { test } = require('node:test');
const assert = require('node:assert');
const {
  SAMPLE_WORDS,
  createAndConnectClient,
  waitForState
} = require('./helpers');

test('Codenames Duet (cnduet) live integration test', async (t) => {
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

  await t.test('1. Host creates a Duet room and receives roomID', async () => {
    const res = await createAndConnectClient({
      gameName: 'cnduet',
      playerName: 'HostAlice'
    });
    hostProvider = res.provider;
    hostClient = res.client;

    assert.ok(hostClient.isConnected, 'Host should be connected');
    assert.strictEqual(hostClient.playerID, '0', 'Host should have playerID "0"');
    assert.ok(hostClient.roomID, 'Host should receive a non-empty roomID');
    assert.strictEqual(typeof hostClient.roomID, 'string');
    assert.match(hostClient.roomID, /^[a-z]+-[a-z]+$/, 'Room ID should follow syllable slug format');
    assert.strictEqual(hostClient.state?.ctx?.phase, 'lobby', 'Initial phase should be lobby');
  });

  await t.test('2. Guest joins room using the allocated roomID', async () => {
    const res = await createAndConnectClient({
      gameName: 'cnduet',
      playerName: 'GuestBob',
      roomID: hostClient.roomID
    });
    guestProvider = res.provider;
    guestClient = res.client;

    assert.ok(guestClient.isConnected, 'Guest should be connected');
    assert.strictEqual(guestClient.playerID, '1', 'Guest should have playerID "1"');
    assert.strictEqual(guestClient.roomID, hostClient.roomID, 'Guest should be in the same room');
  });

  await t.test('3. Players join Duet teams (side1 and side2)', async () => {
    hostClient.joinTeam('side1');
    guestClient.joinTeam('side2');

    await waitForState(
      hostClient,
      s => s.G?.teams?.side1?.['p#0'] && s.G?.teams?.side2?.['p#1'],
      10000,
      'teams populated in host state'
    );

    await waitForState(
      guestClient,
      s => s.G?.teams?.side1?.['p#0'] && s.G?.teams?.side2?.['p#1'],
      10000,
      'teams populated in guest state'
    );

    assert.strictEqual(hostClient.myTeam, 'side1');
    assert.strictEqual(guestClient.myTeam, 'side2');
  });

  await t.test('4. Host starts match with 25 words', async () => {
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
    assert.strictEqual(guestClient.state.G.grid.length, 25);

    // Verify 25 words are dealt (server shuffles the words)
    const hostWords = hostClient.state.G.grid.map(c => c.word);
    assert.strictEqual(hostWords.length, 25);
    assert.deepStrictEqual(new Set(hostWords), new Set(SAMPLE_WORDS.map(w => w.word)));
  });

  await t.test('5. Tip card move syncs across clients', async () => {
    const targetWord = hostClient.state.G.grid[4].word;
    guestClient.tipCard(targetWord);

    await waitForState(
      hostClient,
      s => !!s.G?.grid?.find(c => c.word === targetWord)?.tips?.['p#1'],
      10000,
      'tip on card in host state'
    );

    await waitForState(
      guestClient,
      s => !!s.G?.grid?.find(c => c.word === targetWord)?.tips?.['p#1'],
      10000,
      'tip on card in guest state'
    );

    const hostCard = hostClient.state.G.grid.find(c => c.word === targetWord);
    const guestCard = guestClient.state.G.grid.find(c => c.word === targetWord);
    assert.ok(hostCard.tips['p#1'], 'Host should see guest tip');
    assert.ok(guestCard.tips['p#1'], 'Guest should see own tip');
  });

  await t.test('6. Clue giving and guessing workflow', async () => {
    // In Duet, Alice (side1) gives a clue
    hostClient.giveClue({ word: 'SAFARI', number: 2 });

    // Wait for Bob (side2) to become active operative
    await waitForState(
      guestClient,
      s => s.G?.activeRole === 'operatives' && s.G?.activeTeam === 'side2',
      10000,
      'Bob active operative'
    );

    assert.strictEqual(guestClient.state.G.activeRole, 'operatives');
    assert.strictEqual(guestClient.state.G.activeTeam, 'side2');

    // Bob guesses a green card
    const targetWord = hostClient.state.G.grid.find(c => c.color === 'green').word;
    guestClient.guessCard(targetWord);

    await waitForState(
      guestClient,
      s => s.G?.grid?.find(c => c.word === targetWord)?.revealed?.side2 === true,
      10000,
      'card revealed'
    );

    const revealedCard = guestClient.state.G.grid.find(c => c.word === targetWord);
    assert.strictEqual(revealedCard.revealed.side2, true);

    // Guest ends guessing
    guestClient.endGuessing();

    await waitForState(
      hostClient,
      s => s.G?.activeRole === 'spymasters',
      10000,
      'guessing ended'
    );
    assert.strictEqual(hostClient.state.G.activeRole, 'spymasters');
  });
});
