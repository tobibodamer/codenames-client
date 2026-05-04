/**
 * game/CNDuetGame.ts
 *
 * boardgame.io Game definition for Codenames Duet, ported from the
 * codenames.game production bundle. This is passed to Client() so the
 * framework understands move names, phases, and playerView filtering.
 *
 * Move implementations are kept accurate to the source so that local
 * optimistic state (if ever needed) matches the server.
 */

import { INVALID_MOVE, ActivePlayers, TurnOrder } from 'boardgame.io/core';
import { nanoid } from 'nanoid';
import type { Game } from 'boardgame.io';

// codenames.game uses a forked boardgame.io with extra Move fields.
// We use `as unknown as Game` at the bottom to bypass strict type checking.
type ExtendedMove = {
  client?: boolean;
  undoable?: boolean;
  redact?: boolean;
  ignoreStaleStateID?: boolean;
  allowAfterGameover?: boolean;
  sanitizeArgs?: (args: any[]) => any[];
  move: (...args: any[]) => any;
};
import type { Team, SetupData, GameStateDuet } from '../../types';
import {
  getPlayerSide,
  getOtherDuetTeam,
  isDuetPlayersTurn,
  placeDuetCoverToken,
  placeTimeToken,
  discardTimeToken,
  calcRemainingCards,
  setDuetGameover,
  endDuetTeamTurn,
  checkSuggestionsForWord,
  cleanupPlayerTips,
  cleanTips,
  type GameEnvDuet,
} from './helpers';
import {
  sanitizeTextInput,
  sanitizeClueNumberInput,
  getRandomSelectedAndRest,
  shuffleArray,
  updateTimerValue,
} from '../utils';

// ─── Default setup ─────────────────────────────────────────────────────────────

const defaultSetupData: SetupData = {
  wordLanguage: 'en',
  wordPacks: [],
  defaultPacks: true,
  mode: 'normal',
  timer: {
    variant: 'off',
    spymasterTimer: 180,
    operativeTimer: 90,
    extraTime: 120,
  },
};

// ─── Game definition ───────────────────────────────────────────────────────────

export const CNDuetGame: Game<GameStateDuet> = {
  name: 'cnduet',

  defaultSetupData,
  deltaState: true,
  disableUndo: true,

  setup: (_, setupData: any): GameStateDuet => {
    const config = {
      wordLanguage: 'en',
      wordPacks: [] as string[],
      defaultPacks: true,
      mode: 'normal',
      timer: {
        variant: 'off',
        spymasterTimer: 180,
        operativeTimer: 90,
        extraTime: 120,
      },
    };

    if (setupData?.playerLocale) config.wordLanguage = setupData.playerLocale;
    if (setupData?.setup) {
      if (setupData.setup.wordLanguage) config.wordLanguage = setupData.setup.wordLanguage;
      if (setupData.setup.wordPacks) {
        config.wordPacks = setupData.setup.wordPacks;
        config.defaultPacks = setupData.setup.wordPacks.length === 0;
      }
      if (setupData.setup.mode) config.mode = setupData.setup.mode;
      if (setupData.setup.timer) config.timer = setupData.setup.timer;
    }

    // Carry over teams from previous match (play again flow)
    let teams: GameStateDuet['teams'] = { side1: {}, side2: {} };
    if (setupData?.teams) {
      if (setupData.teams.red && setupData.teams.blue) {
        teams.side1 = { ...setupData.teams.red.operatives, ...setupData.teams.red.spymasters };
        teams.side2 = { ...setupData.teams.blue.operatives, ...setupData.teams.blue.spymasters };
      } else if (setupData.teams.side1 && setupData.teams.side2) {
        teams.side1 = { ...setupData.teams.side1 };
        teams.side2 = { ...setupData.teams.side2 };
      }
    }

    return {
      activeTeam: null,
      activeRole: 'spymasters',
      grid: [],
      coverCards: [],
      timerTokens: [],
      cardsDealed: false,
      teams,
      remainingCards: { side1: 0, side2: 0 },
      gameover: null,
      lockTeams: false,
      timer: {},
      banBuffer: setupData?.banBuffer ?? {},
      suggestions: { side1: [], side2: [] },
    };
  },

  phases: {
    lobby: { start: true },
    game: {},
    gameover: {},
  },

  turn: {
    activePlayers: ActivePlayers.ALL,
    order: TurnOrder.RESET,
  },

  moves: {
    // ── Timer (server-authoritative, redacted) ──────────────────────────────
    pauseTimer: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, value: number) => {
        env.G.timer = env.G.timer ?? {};
        env.G.timer.ts = Date.now();
        env.G.timer.value = value;
        env.G.timer.running = false;
      },
    },

    startTimer: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, value: number) => {
        env.G.timer = env.G.timer ?? {};
        env.G.timer.ts = Date.now();
        env.G.timer.value = value;
        env.G.timer.running = true;
      },
    },

    timerEndTurn: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, player: any, role: string) => {
        if (!player.team || player.team === env.G.activeTeam || role !== env.G.activeRole) {
          return INVALID_MOVE;
        }
        discardTimeToken(env);
        endDuetTeamTurn(env, ['timerEndTurnAnimation']);
      },
    },

    // ── Lobby moves ─────────────────────────────────────────────────────────
    joinTeam: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      allowAfterGameover: true,
      move: (env, team: Team, overridePlayerID: string | null = null) => {
        if (env.G.lockTeams) return INVALID_MOVE;
        if (!team || !env.G.teams[team]) return INVALID_MOVE;

        const pid = overridePlayerID ?? env.playerID;
        const key = `p#${pid}`;

        if (env.G.teams[team][key]) return INVALID_MOVE;

        delete env.G.teams.side1[key];
        delete env.G.teams.side2[key];
        env.G.teams[team][key] = true;
        cleanupPlayerTips(env, pid);
      },
    },

    leaveTeam: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      allowAfterGameover: true,
      move: (env, overridePlayerID?: string) => {
        if (!env.G.teams?.side1 || !env.G.teams?.side2) return INVALID_MOVE;
        const pid = String(overridePlayerID ?? env.playerID);
        const key = `p#${pid}`;
        delete env.G.teams.side1[key];
        delete env.G.teams.side2[key];
        cleanupPlayerTips(env, pid);
      },
    },

    setLockTeams: {
      allowAfterGameover: true,
      move: (env, value: boolean) => {
        env.G.lockTeams = value;
      },
    },

    resetTeams: {
      client: false,
      redact: true,
      move: (env) => {
        env.G.teams.side1 = {};
        env.G.teams.side2 = {};
        cleanTips(env);
      },
    },

    randomizeTeams: {
      client: false,
      redact: true,
      move: (env, players: Array<{ id: number }>) => {
        env.G.teams.side1 = {};
        env.G.teams.side2 = {};

        const sides: Team[] = ['side1', 'side2'];
        const keys = (players ?? []).map(p => `p#${String(p.id)}`);
        shuffleArray(keys);

        let idx = Math.floor(Math.random() * 2);
        for (const key of keys) {
          env.G.teams[sides[idx]][key] = true;
          idx = (idx + 1) % 2;
        }
        cleanTips(env);
      },
    },

    // ── Game start ──────────────────────────────────────────────────────────
    startMatch: {
      client: false,
      sanitizeArgs: ([words]: [Array<{ word: string }>]) => [
        words.map(w => ({ ...w, word: sanitizeTextInput(w.word, 36) })),
      ],
      move: (env, words: Array<{ word: string; packName: string; packSize: number }>) => {
        if (env.G.cardsDealed) return INVALID_MOVE;

        env.G.banBuffer ??= {}

        // Build ban buffer
        for (const entry of words) {
          env.G.banBuffer[entry.packName] = env.G.banBuffer[entry.packName] ?? [];
          env.G.banBuffer[entry.packName].push(entry.word);
          const maxBan = Math.round(0.25 * entry.packSize);
          const overflow = env.G.banBuffer[entry.packName].length - maxBan;
          if (overflow > 0) {
            env.G.banBuffer[entry.packName] = env.G.banBuffer[entry.packName].slice(overflow);
          }
        }

        const wordList = words.map(w => w.word);
        if (wordList.length < 25) return INVALID_MOVE;

        // ── Distribute 25 words into color zones ──
        // 3 green/green, 5 green/neutral, 5 neutral/green,
        // 1 black/green, 1 green/black, 1 black/black, 1 black/neutral, 1 neutral/black
        // remaining = neutral/neutral
        let selected: string[], rest: string[];
        let greenGreen: string[], afterGG: string[];
        let greenNeutral: string[], afterGN: string[];
        let neutralGreen: string[], afterNG: string[];
        let blackGreen: string[], afterBG: string[];
        let greenBlack: string[];

        let remaining: string[], rem2: string[], rem3: string[];
        let blackBlack: string[];
        let blackNeutral: string[];
        let neutralBlack: string[];

        try {
          [selected, rest] = getRandomSelectedAndRest(wordList, 15);
          [greenGreen, afterGG] = getRandomSelectedAndRest(selected, 3);
          [greenNeutral, afterGN] = getRandomSelectedAndRest(afterGG, 5);
          [neutralGreen, afterNG] = getRandomSelectedAndRest(afterGN, 5);
          [blackGreen, afterBG] = getRandomSelectedAndRest(afterNG, 1);
          [greenBlack] = getRandomSelectedAndRest(afterBG, 1);
        } catch (e: any) {
          console.error('startMatch: word distribution error', e.message);
          return INVALID_MOVE;
        }

        try {
          [blackBlack, remaining] = getRandomSelectedAndRest(rest, 1);
          [blackNeutral, rem2] = getRandomSelectedAndRest(remaining, 1);
          [neutralBlack, rem3] = getRandomSelectedAndRest(rem2, 1);
        } catch (e: any) {
          console.error('startMatch: remaining distribution error', e.message);
          return INVALID_MOVE;
        }

        // neutralNeutral = rem3 (all leftovers)
        const neutralNeutral = rem3;

        const coloredWords = [
          ...greenGreen.map(w => ({ word: w, colors: { side1: 'green', side2: 'green' } })),
          ...greenNeutral.map(w => ({ word: w, colors: { side1: 'green', side2: 'neutral' } })),
          ...neutralGreen.map(w => ({ word: w, colors: { side1: 'neutral', side2: 'green' } })),
          ...blackGreen.map(w => ({ word: w, colors: { side1: 'black', side2: 'green' } })),
          ...greenBlack.map(w => ({ word: w, colors: { side1: 'green', side2: 'black' } })),
          ...blackBlack.map(w => ({ word: w, colors: { side1: 'black', side2: 'black' } })),
          ...blackNeutral.map(w => ({ word: w, colors: { side1: 'black', side2: 'neutral' } })),
          ...neutralBlack.map(w => ({ word: w, colors: { side1: 'neutral', side2: 'black' } })),
          ...neutralNeutral.map(w => ({ word: w, colors: { side1: 'neutral', side2: 'neutral' } })),
        ];

        shuffleArray(coloredWords);

        env.G.grid = coloredWords.map(({ word, colors }, index) => ({
          index,
          word,
          colors,
          revealed: { side1: false, side2: false },
          selected: false,
          tips: {},
        })) as any;

        // 15 green cover cards + 1 black
        for (let i = 0; i < 15; i++) {
          env.G.coverCards.push({
            index: env.G.coverCards.length,
            color: 'green',
            location: 'greenDeck',
            gridIndex: null,
            teamPlaced: null,
          });
        }
        env.G.coverCards.push({
          index: env.G.coverCards.length,
          color: 'black',
          location: 'offscreenDeck',
          gridIndex: null,
          teamPlaced: null,
        });

        // 9 timer tokens
        for (let i = 0; i < 9; i++) {
          env.G.timerTokens.push({
            index: env.G.timerTokens.length,
            location: 'timerDeck',
            gridIndex: null,
            teamPlaced: null,
          });
        }

        env.G.cardsDealed = true;
        env.events.setPhase('game');
        calcRemainingCards(env);
        updateTimerValue(env, ['spymaster', 'extraTime', 'startAnimation']);
      },
    },

    // ── In-game moves ────────────────────────────────────────────────────────
    giveClue: {
      client: false,
      sanitizeArgs: ([clue, player, words]: [any, any, any]) => {
        const word = sanitizeTextInput(clue.word, 32);
        const number = sanitizeClueNumberInput(clue.number);
        return [{ word, number, suggestionID: clue.suggestionID }, player, words];
      },
      move: (env, clue: any, player: any, selectedWords: string[]) => {
        if (!isDuetPlayersTurn(env) || env.G.gameover !== null) {
          return INVALID_MOVE;
        }

        // Remove matched suggestion if this clue came from one
        if (clue.suggestionID) {
          env.G.suggestions[player.team] = env.G.suggestions[player.team].filter(
            (s: any) => s.id !== clue.suggestionID
          );
        }

        env.log.setMetadata({
          playerID: env.playerID,
          playerName: player.name,
          playerImage: player.image,
          playerTeam: player.team,
          selectedWords: selectedWords ?? [],
        });

        env.G.activeRole = 'operatives';
        env.G.activeTeam = getOtherDuetTeam(player.team);

        if ((env.setupData as SetupData)?.timer?.variant !== 'off') {
          updateTimerValue(env, ['operative', 'giveClueAnimation']);
        }
      },
    },

    guessCard: {
      client: false,
      move: (env, word: string, player: any) => {
        if (
          !isDuetPlayersTurn(env) ||
          env.G.activeRole !== 'operatives' ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }

        let logMeta: Record<string, unknown> = {};

        env.G.grid = env.G.grid.map((card: any) => {
          if (card.word !== word) return card;

          if (card.revealed[player.team]) return card; // already revealed

          const otherTeam = getOtherDuetTeam(player.team);
          // The card's color from the OTHER team's perspective determines the outcome
          const cardColor = card.colors[otherTeam];

          logMeta = {
            playerID: env.playerID,
            playerName: player.name,
            playerImage: player.image,
            playerTeam: player.team,
            cardColor,
          };

          card.tips = {};

          if (cardColor === 'black') {
            // Assassin — instant loss
            card.revealed[player.team] = true;
            placeDuetCoverToken(env, 'black', card, player.team);
            setDuetGameover(env, 'assassin');
          } else if (cardColor !== 'green') {
            // Neutral — use a timer token and end turn
            if (env.G.timerTokens.filter((t: any) => t.location === 'timerDeck').length === 0) {
              setDuetGameover(env, 'time');
              return card;
            }
            card.revealed[player.team] = true;
            placeTimeToken(env, card, player.team);
            endDuetTeamTurn(env, ['badGuessAnimation']);
          } else {
            // Green — correct guess, reveal for both sides
            placeDuetCoverToken(env, 'green', card, player.team);
            card.revealed.side1 = true;
            card.revealed.side2 = true;
            checkSuggestionsForWord(env, card.word);
            calcRemainingCards(env);

            if (
              env.G.remainingCards.side1 === 0 &&
              env.G.remainingCards.side2 === 0
            ) {
              setDuetGameover(env, 'score');
              return card;
            }

            // If the OTHER team's remaining count hits 0, discard a token and switch turns
            if (env.G.remainingCards[otherTeam] === 0) {
              discardTimeToken(env);
              endDuetTeamTurn(env, ['badGuessAnimation']);
            }
          }

          return card;
        });

        env.log.setMetadata(logMeta);
      },
    },

    endGuessing: {
      client: false,
      move: (env, player: any) => {
        if (!isDuetPlayersTurn(env) || env.G.gameover !== null) {
          return INVALID_MOVE;
        }
        env.log.setMetadata({
          playerID: env.playerID,
          playerName: player.name,
          playerImage: player.image,
          playerTeam: player.team,
        });
        discardTimeToken(env);
        endDuetTeamTurn(env, ['endGuessingAnimation']);
      },
    },

    tipCard: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      move: (env, word: string) => {
        if (
          (!isDuetPlayersTurn(env) && env.G.activeRole !== 'operatives') ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }
        const key = `p#${env.playerID}`;
        env.G.grid = env.G.grid.map((card: any) => {
          if (card.word === word) {
            if (card.tips[key]) delete card.tips[key];
            else card.tips[key] = true;
          }
          return card;
        });
      },
    },

    // ── Suggestion moves ─────────────────────────────────────────────────────
    addSuggestion: {
      client: false,
      undoable: false,
      redact: true,
      sanitizeArgs: ([clue, player, words]: [any, any, string[]]) => {
        const word = sanitizeTextInput(clue.word, 32);
        const number = sanitizeClueNumberInput(clue.number);
        return [{ word, number, words }, player];
      },
      move: (env, clue: any, player: any) => {
        const suggestion = {
          id: nanoid(),
          word: clue.word,
          number: clue.number,
          words: clue.words ?? [],
          author: player,
          likes: {},
          warnings: {},
        };
        env.G.suggestions[player.team].push(suggestion);
      },
    },

    removeSuggestion: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, id: string, team: string) => {
        env.G.suggestions[team] = env.G.suggestions[team].filter((s: any) => s.id !== id);
      },
    },

    likeSuggestionToggle: {
      client: true,
      undoable: false,
      redact: true,
      move: (env, id: string, player: any) => {
        const team = player?.team ?? getPlayerSide(env.G, String(player?.id)).team;
        if (!team) return INVALID_MOVE;

        const suggestion = env.G.suggestions[team].find((s: any) => s.id === id);
        if (!suggestion) return INVALID_MOVE;

        const key = player?.id != null ? `p#${String(player.id)}` : `p#${env.playerID}`;
        if (suggestion.likes[key]) delete suggestion.likes[key];
        else suggestion.likes[key] = true;
      },
    },

    warningSuggestionToggle: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, id: string, player: any, warningType: string) => {
        const team = player?.team ?? getPlayerSide(env.G, String(player?.id)).team;
        if (!team) return INVALID_MOVE;

        const suggestion = env.G.suggestions[team].find((s: any) => s.id === id);
        if (!suggestion) return INVALID_MOVE;

        const key = `p#${String(player.id ?? env.playerID)}`;
        const category = String(warningType);

        suggestion.warnings[category] = suggestion.warnings[category] ?? [];
        const arr: string[] = suggestion.warnings[category];
        const idx = arr.indexOf(key);
        if (idx >= 0) {
          arr.splice(idx, 1);
          if (arr.length === 0) delete suggestion.warnings[category];
        } else {
          arr.push(key);
        }
      },
    },
  },

  // ── playerView ─────────────────────────────────────────────────────────────
  // Strips card `colors` (full per-team map) down to a single `color` value
  // for this player's team. This mirrors what the real server sends.
  playerView: ({ G, ctx, playerID }: { G: GameStateDuet; ctx: any; playerID: string | null }) => {
    if (!G.teams?.side1 || !G.teams?.side2) {
      console.warn('[playerView] called with incompatible game state');
      return G;
    }

    const { team } = getPlayerSide(G, playerID ?? '');

    const filteredG = {
      ...G,
      grid: G.grid.map(({ ...card }) => {
        const colors = (card as any).colors as Record<Team, string> | undefined;
        const color = team && colors ? colors[team] : null;
        const { colors: _stripped, ...rest } = card as any;
        return { ...rest, color };
      }),
    };

    // banBuffer is only available in the lobby phase
    if (ctx.phase !== 'lobby') {
      delete (filteredG as any).banBuffer;
    }

    return filteredG;
  },
} as Game<GameStateDuet>;