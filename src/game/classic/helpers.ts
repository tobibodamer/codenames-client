/**
 * game/classicHelpers.ts
 *
 * Helpers for the Classic (cno2) game, ported from the codenames.game
 * production bundle. Mirrors the structure of helpers.ts (Duet) but adapted
 * for the Classic team/role model and single-boolean `revealed` field.
 */

import { INVALID_MOVE } from 'boardgame.io/core';
import { Ctx } from 'boardgame.io';
import type {
  ClassicTeam,
  Role,
  GameStateClassic,
  GridCardClassicFull,
  ClassicGridConfig,
  SetupDataClassic,
} from '../../types';
import {
  getRandomSelectedAndRest,
  updateTimerValue,
} from '../utils';

// ─── Environment type ──────────────────────────────────────────────────────────

export interface ClassicGameEnv {
  G: GameStateClassic;
  ctx: Ctx;
  playerID: string;
  random: {
    /** Returns a value in [1, 6] */
    D6: () => number;
    Shuffle: <T>(arr: T[]) => T[];
  };
  events: {
    setPhase: (phase: string) => void;
    endGame: (result: object) => void;
    endTurn: () => void;
  };
  log: {
    setMetadata: (meta: object) => void;
  };
  setupData?: SetupDataClassic;
}

// ─── Player / team helpers ─────────────────────────────────────────────────────

/**
 * Returns the team and role for a given playerID.
 * Mirrors `getPlayerTeamRole` from the bundle (used in playerView).
 */
export function getPlayerTeamRole(
  G: GameStateClassic,
  playerID: string | null
): { team: ClassicTeam | null; role: Role | null } {
  if (!playerID) return { team: null, role: null };
  const key = `p#${playerID}`;
  for (const role of ['spymasters', 'operatives'] as Role[]) {
    for (const team of ['red', 'blue'] as ClassicTeam[]) {
      if (G.teams[role]?.[team]?.[key]) return { team, role };
    }
  }
  return { team: null, role: null };
}

/**
 * Returns true when the current player belongs to the active team + role.
 * Mirrors `isPlayersTurn` from the bundle.
 */
export function isPlayersTurn(env: ClassicGameEnv): boolean {
  const key = `p#${env.playerID}`;
  return (
    !!env.G.activeTeam &&
    !!env.G.activeRole &&
    !!env.G.teams[env.G.activeRole]?.[env.G.activeTeam] &&
    !!env.G.teams[env.G.activeRole][env.G.activeTeam][key]
  );
}

// ─── Match setup ──────────────────────────────────────────────────────────────

/**
 * Populates G.grid and G.coverCards from a word list.
 * Mirrors `startMatch` from the bundle.
 *
 * @param env  - boardgame.io move environment
 * @param words - word entries with pack metadata (for ban-buffer tracking)
 * @param config - card count distribution (default: 9/8/7/1)
 */
export function startMatch(
  env: ClassicGameEnv,
  words: Array<{ word: string; packName: string; packSize: number }>,
  config: ClassicGridConfig = {
    startingTeam: 9,
    otherTeam: 8,
    neutral: 7,
    assasin: 1,
  }
): typeof INVALID_MOVE | void {
  // ── Coin flip for starting team ──
  const startingTeam: ClassicTeam = env.random.D6() % 2 === 0 ? 'red' : 'blue';
  const otherTeam: ClassicTeam = startingTeam === 'red' ? 'blue' : 'red';

  env.G.startingTeam = startingTeam;
  env.G.activeTeam = startingTeam;
  env.G.activeRole = 'spymasters';

  // ── Update ban buffer ──
  env.G.banBuffer ??= {};
  for (const entry of words) {
    env.G.banBuffer[entry.packName] ??= [];
    env.G.banBuffer[entry.packName].push(entry.word);
    const maxBan = Math.round(0.25 * entry.packSize);
    const overflow = env.G.banBuffer[entry.packName].length - maxBan;
    if (overflow > 0) {
      env.G.banBuffer[entry.packName] = env.G.banBuffer[entry.packName].slice(overflow);
    }
  }

  const wordList = words.map(w => w.word);
  const required =
    config.startingTeam + config.otherTeam + config.neutral + (config.assasin ?? 1);

  if (wordList.length < required) {
    console.error(
      `startMatch: Not enough words. Required: ${required}, Got: ${wordList.length}, Words: ${wordList.join(',')}`
    );
    return INVALID_MOVE;
  }

  // ── Distribute words into color buckets ──
  let redWords: string[],
    blueWords: string[],
    neutralWords: string[],
    afterRed: string[],
    afterBlue: string[],
    afterNeutral: string[];

  try {
    [redWords, afterRed] = getRandomSelectedAndRest(
      wordList,
      startingTeam === 'red' ? config.startingTeam : config.otherTeam
    );
    [blueWords, afterBlue] = getRandomSelectedAndRest(
      afterRed,
      startingTeam === 'blue' ? config.startingTeam : config.otherTeam
    );
    [neutralWords, afterNeutral] = getRandomSelectedAndRest(afterBlue, config.neutral);
  } catch (e: any) {
    console.error(
      `startMatch: Error during word distribution. selectedWords.length=${wordList.length}, gridSize=${JSON.stringify(config)}, error=${e.message}`
    );
    return INVALID_MOVE;
  }

  // afterNeutral contains the assassin word(s)
  const assassinWords = afterNeutral;

  // ── Build the grid (preserving original word order) ──
  wordList.forEach((word, index) => {
    const color =
      redWords.indexOf(word) > -1
        ? 'red'
        : blueWords.indexOf(word) > -1
        ? 'blue'
        : neutralWords.indexOf(word) > -1
        ? 'neutral'
        : 'black';

    env.G.grid.push({
      index,
      word,
      color,
      revealed: false,
      selected: false,
      tips: {},
    } as any);
  });

  // ── Build cover card decks ──
  redWords.forEach(() => {
    env.G.coverCards.push({
      index: env.G.coverCards.length,
      color: 'red',
      location: 'redDeck',
      gridIndex: null,
    });
  });

  blueWords.forEach(() => {
    env.G.coverCards.push({
      index: env.G.coverCards.length,
      color: 'blue',
      location: 'blueDeck',
      gridIndex: null,
    });
  });

  neutralWords.forEach(() => {
    env.G.coverCards.push({
      index: env.G.coverCards.length,
      color: 'neutral',
      location: 'offscreenDeck',
      gridIndex: null,
    });
  });

  assassinWords.forEach(() => {
    env.G.coverCards.push({
      index: env.G.coverCards.length,
      color: 'black',
      location: 'offscreenDeck',
      gridIndex: null,
    });
  });

  env.G.cardsDealed = true;

  // ── Coop mode: merge both teams onto the starting side ──
  if (env.setupData?.mode === 'coop') {
    env.G.teams.operatives[startingTeam] = {
      ...env.G.teams.operatives[startingTeam],
      ...env.G.teams.operatives[otherTeam],
    };
    env.G.teams.spymasters[startingTeam] = {
      ...env.G.teams.spymasters[startingTeam],
      ...env.G.teams.spymasters[otherTeam],
    };
    env.G.teams.operatives[otherTeam] = {};
    env.G.teams.spymasters[otherTeam] = {};
  }
}

// ─── Cover token ──────────────────────────────────────────────────────────────

/**
 * Moves the first available cover card matching the grid card's color onto the grid.
 * Mirrors `placeCoverToken` from the bundle.
 */
export function placeCoverToken(
  env: ClassicGameEnv,
  card: GridCardClassicFull
): void {
  const color = card.color;
  for (const cover of env.G.coverCards) {
    if (cover.color === color && cover.location !== 'grid') {
      cover.location = 'grid';
      cover.gridIndex = card.index;
      break;
    }
  }
}

// ─── Win condition ────────────────────────────────────────────────────────────

/**
 * Checks whether either team's deck is exhausted and triggers gameover.
 * Mirrors `checkScoreWin` (the `s` closure) from the bundle.
 */
export function checkScoreWin(env: ClassicGameEnv): void {
  const redDepleted =
    env.G.coverCards.filter(c => c.color === 'red' && c.location === 'redDeck').length === 0;
  const blueDepleted =
    env.G.coverCards.filter(c => c.color === 'blue' && c.location === 'blueDeck').length === 0;

  if (redDepleted) setGameover(env, 'red', 'score');
  if (blueDepleted) setGameover(env, 'blue', 'score');
}

export function setGameover(
  env: ClassicGameEnv,
  team: ClassicTeam,
  reason: string
): void {
  env.G.gameover = { team, reason } as any;
  env.events.setPhase('gameover');
  env.events.endGame({ team, reason });
}

// ─── Turn management ──────────────────────────────────────────────────────────

/**
 * Ends the current team's turn and switches to the other team's spymaster phase.
 * In coop mode, triggers a random reveal on the non-starting team instead.
 * Mirrors `endTeamTurn` (the `l` closure) from the bundle.
 */
export function endTeamTurn(env: ClassicGameEnv, _animations: string[] = []): void {
  if (env.setupData?.mode === 'coop') {
    coopEndTurn(env);
  } else {
    const current = env.G.activeTeam!;
    env.G.activeTeam = current === 'red' ? 'blue' : 'red';
  }

  env.G.activeRole = 'spymasters';
  cleanTips(env);
  updateTimerValue(env as any, ['spymaster', ..._animations]);
}

/**
 * Coop penalty: randomly reveals one unrevealed card belonging to the
 * non-starting team, then checks for a score win.
 * Mirrors the `u` closure from the bundle.
 */
function coopEndTurn(env: ClassicGameEnv): void {
  const penaltyTeam: ClassicTeam = env.G.startingTeam === 'red' ? 'blue' : 'red';
  let candidates = (env.G.grid as any[]).filter(
    (c: any) => c.color === penaltyTeam && !c.revealed
  );
  candidates = env.random.Shuffle(candidates);

  env.G.grid = (env.G.grid as any[]).map((card: any) => {
    if (card.word === candidates[0]?.word) {
      card.revealed = true;
      placeCoverToken(env, card);
    }
    return card;
  }) as any;

  checkScoreWin(env);
}

// ─── Tip helpers ──────────────────────────────────────────────────────────────

/**
 * Clears all tip markers from every card.
 * Mirrors `cleanTips` from the bundle.
 */
export function cleanTips(env: ClassicGameEnv): void {
  env.G.grid = (env.G.grid as any[]).map((card: any) => {
    if (card.tips) card.tips = {};
    return card;
  }) as any;
}

/**
 * Removes a single player's tip markers from all cards.
 * Mirrors `cleanupPlayerTips` from the bundle.
 */
export function cleanupPlayerTips(env: ClassicGameEnv, playerID: string): void {
  const key = `p#${playerID}`;
  env.G.grid = (env.G.grid as any[]).map((card: any) => {
    delete card.tips[key];
    return card;
  }) as any;
}