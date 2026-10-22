const { createCodenamesProvider, CodenamesClient } = require('../dist');
const { firstValueFrom, filter, map } = require('rxjs');

const SAMPLE_WORDS = [
  'APPLE', 'BEACH', 'CAT', 'DOG', 'EAGLE',
  'FOREST', 'GHOST', 'HORSE', 'ICE', 'JUNGLE',
  'KING', 'LION', 'MOON', 'NIGHT', 'OCEAN',
  'PIRATE', 'QUEEN', 'RIVER', 'SUN', 'TREE',
  'UMBRELLA', 'VOLCANO', 'WATER', 'XYLOPHONE', 'ZEBRA'
].map(word => ({
  word,
  packSize: 400,
  packName: 'Codenames',
  packType: 'base',
  mix: 'add'
}));

/**
 * Creates and starts a provider, then returns a synchronized CodenamesClient.
 */
async function createAndConnectClient({
  gameName = 'cnduet',
  playerName,
  roomID,
  credentials,
  timeoutMs = 25000
}) {
  const clientOpts = {
    playerName,
    roomID: roomID || undefined,
  };
  if (credentials) {
    clientOpts.credentials = credentials;
  }

  const provider = createCodenamesProvider({
    serverURL: 'https://server-discord.gke.codenames.game',
    gameName,
    clientOpts
  });

  provider.start();

  const client = await firstValueFrom(
    provider.state$.pipe(
      filter(s => !!s.client),
      map(s => new CodenamesClient(s.client))
    )
  );

  await client.waitForSync(timeoutMs);

  return { provider, client };
}

/**
 * Waits until client state satisfies a predicate.
 */
function waitForState(client, predicate, timeoutMs = 20000, desc = 'predicate') {
  return new Promise((resolve, reject) => {
    const current = client.state;
    if (current && predicate(current)) {
      return resolve(current);
    }

    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${desc}`));
    }, timeoutMs);

    const unsub = client.subscribe(state => {
      if (state && predicate(state)) {
        clearTimeout(timer);
        unsub();
        resolve(state);
      }
    });
  });
}

module.exports = {
  SAMPLE_WORDS,
  createAndConnectClient,
  waitForState
};
