/**
 * game/helpers.ts
 *
 * Ported from the codenames.game bundle. These are the `l` and `s` module
 * exports used internally by CNDuetGame moves.
 */

import { INVALID_MOVE } from 'boardgame.io/core';
import type { DuetTeam, GameState, GameStateDuet, GridCardFull, Team } from '../../types';
import { Ctx } from 'boardgame.io';

// ─── Types used only within the game engine ────────────────────────────────

export interface GameEnvDuet {
  G: GameStateDuet;
  ctx: Ctx;
  playerID: string;
  events: {
    setPhase: (phase: string) => void;
    endGame: (result: object) => void;
    endTurn: () => void;
  };
  log: {
    setMetadata: (meta: object) => void;
  };
  setupData?: {
    timer?: { variant: string };
  };
}

// ─── Player/team helpers ───────────────────────────────────────────────────

export function getPlayerSide(
  G: GameStateDuet,
  playerID: string
): { team: DuetTeam | null } {
  const key = `p#${playerID}`;
  for (const team of Object.keys(G.teams) as DuetTeam[]) {
    if (G.teams[team][key]) return { team };
  }
  return { team: null };
}

export function getOtherDuetTeam(team: DuetTeam): DuetTeam {
  return team === 'side1' ? 'side2' : 'side1';
}

export function isDuetPlayersTurn(env: GameEnvDuet & { G: GameStateDuet }): boolean {
  const key = `p#${env.playerID}`;
  if (!env.G.teams.side1 || !env.G.teams.side2) return false;
  for (const team of Object.keys(env.G.teams) as DuetTeam[]) {
    if (env.G.teams[team][key]) return true;
  }
  return false;
}

// ─── Card & token placement ────────────────────────────────────────────────

export function placeDuetCoverToken(
  env: GameEnvDuet,
  color: 'green' | 'black',
  card: { index: number },
  team: Team
): void {
  for (const cover of env.G.coverCards) {
    if (cover.color === color && cover.location !== 'grid') {
      cover.location = 'grid';
      cover.gridIndex = card.index;
      cover.teamPlaced = team;
      break;
    }
  }
}

export function placeTimeToken(
  env: GameEnvDuet,
  card: { index: number },
  team: Team
): void {
  for (const token of env.G.timerTokens) {
    if (token.location !== 'grid' && token.location !== 'offscreenDeck') {
      token.location = 'grid';
      token.gridIndex = card.index;
      token.teamPlaced = team;
      break;
    }
  }
}

export function discardTimeToken(env: GameEnvDuet): void {
  for (const token of env.G.timerTokens) {
    if (token.location === 'timerDeck') {
      token.location = 'offscreenDeck';
      break;
    }
  }
}

// ─── Score / remaining cards ───────────────────────────────────────────────

export function calcRemainingCards(env: GameEnvDuet): void {
  env.G.remainingCards = env.G.grid.reduce(
    (acc, card) => {
      // side1's remaining = green cards for side1 that side2 hasn't revealed
      if ((card as any).colors?.side1 === 'green' && !card.revealed.side2) acc.side1++;
      // side2's remaining = green cards for side2 that side1 hasn't revealed
      if ((card as any).colors?.side2 === 'green' && !card.revealed.side1) acc.side2++;
      return acc;
    },
    { side1: 0, side2: 0 }
  );
}

export function setDuetGameover(env: GameEnvDuet, reason: string): void {
  env.G.gameover = { reason } as any;
  env.events.setPhase('gameover');
  env.events.endGame({ reason });
}

// ─── Turn management ───────────────────────────────────────────────────────

export function endDuetTeamTurn(env: GameEnvDuet, _animations: string[] = []): void {
  const timerDeckCount = env.G.timerTokens.filter(t => t.location === 'timerDeck').length;
  const otherTeam = getOtherDuetTeam(env.G.activeTeam!);

  if (timerDeckCount === 0) {
    // No tokens left → sudden death: operatives, no active team
    env.G.activeRole = 'operatives';
    env.G.activeTeam = null;
  } else {
    // If current team has found all their cards, switch to other team's turn
    if (env.G.remainingCards[env.G.activeTeam!] === 0) {
      env.G.activeTeam = otherTeam;
    }
    env.G.activeRole = 'spymasters';
    cleanTips(env);
  }
}

// ─── Tip cleanup ───────────────────────────────────────────────────────────

export function cleanTips(env: GameEnvDuet): void {
  for (const card of env.G.grid) {
    card.tips = {};
  }
}

export function cleanupPlayerTips(env: GameEnvDuet, playerID: string): void {
  const key = `p#${playerID}`;
  for (const card of env.G.grid) {
    delete card.tips[key];
  }
}

// ─── Suggestions ───────────────────────────────────────────────────────────

export function checkSuggestionsForWord(env: GameEnvDuet, word: string): void {
  for (const suggestion of env.G.suggestions.side1) {
    if (suggestion.words.some((w: string) => w === word)) {
      suggestion.words = suggestion.words.filter((w: string) => w !== word);
      if (!suggestion.originalNumber) suggestion.originalNumber = suggestion.number;
      suggestion.number = suggestion.number - 1;
    }
    if (env.G.activeTeam === 'side2' && Object.keys(suggestion.warnings).includes(word)) {
      delete suggestion.warnings[word];
    }
  }
  for (const suggestion of env.G.suggestions.side2) {
    if (suggestion.words.some((w: string) => w === word)) {
      suggestion.words = suggestion.words.filter((w: string) => w !== word);
      if (!suggestion.originalNumber) suggestion.originalNumber = suggestion.number;
      suggestion.number = suggestion.number - 1;
    }
    if (env.G.activeTeam === 'side1' && Object.keys(suggestion.warnings).includes(word)) {
      delete suggestion.warnings[word];
    }
  }
}