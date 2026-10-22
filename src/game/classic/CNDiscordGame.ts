/**
 * game/CNClassicGame.ts
 *
 * boardgame.io Game definition for Codenames Classic (cno2), ported from the
 * codenames.game production bundle.
 *
 * Key differences from CNDuetGame:
 *  - teams are nested: role → team → players  (spymasters.red, operatives.blue, …)
 *  - grid cards have a single `color` and a plain boolean `revealed`
 *  - no timer tokens or suggestions
 *  - guessLimit tracks remaining guesses per clue
 *  - coop mode merges both teams onto the starting side
 */

import { INVALID_MOVE, ActivePlayers, TurnOrder } from 'boardgame.io/core';
import type { Game } from 'boardgame.io';
import type { GameStateClassic, ClassicTeam, Role, SetupDataClassic, ClassicGridConfig } from '../../types';
import {
  getPlayerTeamRole,
  isPlayersTurn,
  startMatch,
  placeCoverToken,
  checkScoreWin,
  setGameover,
  endTeamTurn,
  cleanTips,
  cleanupPlayerTips,
  type ClassicGameEnv,
} from './helpers';
import {
  sanitizeTextInput,
  sanitizeClueNumberInput,
  updateTimerValue,
} from '../utils';

// ─── Default setup ─────────────────────────────────────────────────────────────

const defaultSetupData: SetupDataClassic = {
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

// ─── Default grid config ───────────────────────────────────────────────────────

const defaultGridConfig: ClassicGridConfig = {
  startingTeam: 9,
  otherTeam: 8,
  neutral: 7,
  assasin: 1,
};

// ─── Game definition ───────────────────────────────────────────────────────────

export const CNClassicGame: Game<GameStateClassic> = {
  name: 'cno2',

  defaultSetupData,
  deltaState: true,
  disableUndo: true,

  setup: (_, setupData: any): GameStateClassic => {
    // ── Initial teams structure: role → team → {} ──
    let teams: GameStateClassic['teams'] = {
      red: { operatives: {}, spymasters: {} },
      blue: { operatives: {}, spymasters: {} },
    } as any;

    // Carry over teams from a previous match (play-again flow).
    // Handles both classic (red/blue) and duet (side1/side2) sources.
    if (setupData?.teams) {
      if (setupData.teams.side1 && setupData.teams.side2) {
        // Duet → Classic: flatten sides into operatives (no role distinction)
        (teams as any).operatives = {
          red: { ...setupData.teams.side1 },
          blue: { ...setupData.teams.side2 },
        };
      } else if (setupData.teams.red && setupData.teams.blue) {
        (teams as any) = {
          operatives: {
            red: { ...setupData.teams.red.operatives },
            blue: { ...setupData.teams.blue.operatives },
          },
          spymasters: {
            red: { ...setupData.teams.red.spymasters },
            blue: { ...setupData.teams.blue.spymasters },
          },
        };
      }
    }

    return {
      startingTeam: null,
      activeTeam: null,
      activeRole: null,
      grid: [],
      coverCards: [],
      timerTokens: [],
      cardsDealed: false,
      teams,
      guessLimit: null,
      remainingCards: { red: 0, blue: 0 },
      gameover: null,
      lockTeams: false,
      timer: {},
      banBuffer: setupData?.banBuffer ?? {},
      suggestions: {} as any,
    } as GameStateClassic;
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
      move: (env) => {
        env.G.timer ??= {};
        env.G.timer.ts = Date.now();
        env.G.timer.running = false;
      },
    },

    startTimer: {
      client: false,
      undoable: false,
      redact: true,
      move: (env, value: number) => {
        env.G.timer ??= {};
        env.G.timer.ts = Date.now();
        env.G.timer.value = value;
        env.G.timer.running = true;
      },
    },

    /**
     * Fired by the server when the timer expires mid-turn.
     * The opposing player triggers this; it ends the current team's turn.
     */
    timerEndTurn: {
      client: false,
      undoable: false,
      move: (env, player: any, role: string) => {
        if (!player.team || player.team === env.G.activeTeam || role !== env.G.activeRole) {
          return INVALID_MOVE;
        }
        endTeamTurn(env as unknown as ClassicGameEnv, ['timerEndTurnAnimation']);
      },
    },

    // ── Lobby moves ─────────────────────────────────────────────────────────

    /**
     * Assigns a player to a team + role slot.
     * Removes them from any other slot first (no double-joining).
     */
    joinTeam: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      allowAfterGameover: true,
      move: (env, team: ClassicTeam, role: Role, overridePlayerID: string | null = null) => {
        if (env.G.lockTeams) return INVALID_MOVE;

        if (!env.G.teams?.operatives?.red || !env.G.teams?.operatives?.blue) {
          console.error('Invalid teams structure in joinTeam');
          return INVALID_MOVE;
        }
        if (!team || !(env.G.teams as any).operatives?.[team]) {
          console.error('Invalid team parameter:', team);
          return INVALID_MOVE;
        }
        if (!role || (env.G.teams as any)[role]?.[team] === undefined) {
          console.error('Invalid role parameter:', role);
          return INVALID_MOVE;
        }

        const pid = overridePlayerID ?? env.playerID;
        const key = `p#${pid}`;

        // Already in this slot → no-op
        if ((env.G.teams as any)[role]?.[team]?.[key]) return INVALID_MOVE;

        // Remove from all other slots
        for (const r of ['operatives', 'spymasters'] as Role[]) {
          for (const t of ['red', 'blue'] as ClassicTeam[]) {
            delete (env.G.teams as any)[r]?.[t]?.[key];
          }
        }

        (env.G.teams as any)[role][team][key] = true;
        cleanupPlayerTips(env as unknown as ClassicGameEnv, pid);
      },
    },

    leaveTeam: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      allowAfterGameover: true,
      move: (env, overridePlayerID?: string) => {
        const pid = String(overridePlayerID ?? env.playerID);
        const key = `p#${pid}`;

        if (!env.G.teams?.operatives?.red || !env.G.teams?.operatives?.blue) {
          console.error('Invalid teams structure in leaveTeam');
          return INVALID_MOVE;
        }

        for (const r of ['operatives', 'spymasters'] as Role[]) {
          for (const t of ['red', 'blue'] as ClassicTeam[]) {
            delete (env.G.teams as any)[r]?.[t]?.[key];
          }
        }

        cleanupPlayerTips(env as unknown as ClassicGameEnv, pid);
      },
    },

    setLockTeams: {
      allowAfterGameover: true,
      move: (env, value: boolean) => {
        env.G.lockTeams = value;
      },
    },

    resetTeams: {
      // Note: bundle has a typo `cleint: false` — intentionally corrected here
      client: false,
      redact: true,
      move: (env) => {
        if (!env.G.teams?.operatives?.red || !env.G.teams?.operatives?.blue) {
          console.error('Invalid teams structure in resetTeams');
          return INVALID_MOVE;
        }
        (env.G.teams as any).operatives.red = {};
        (env.G.teams as any).operatives.blue = {};
        (env.G.teams as any).spymasters.red = {};
        (env.G.teams as any).spymasters.blue = {};
        cleanTips(env as unknown as ClassicGameEnv);
      },
    },

    /**
     * Randomly distributes players into team+role slots.
     *
     * Two behaviours depending on game state:
     *  - activeTeam === null (pre-game / lobby): full randomization including spymasters.
     *    First two players become spymasters (one per team), the rest become operatives.
     *  - activeTeam !== null (in-game re-randomize): keeps existing spymasters, only
     *    re-distributes unassigned players as operatives.
     */
    randomizeTeams: {
      client: false,
      redact: true,
      move: (env, players: Array<{ id: number }>) => {
        if (!env.G.teams?.operatives?.red || !env.G.teams?.operatives?.blue) {
          console.error('Invalid teams structure in randomizeTeams');
          return INVALID_MOVE;
        }

        const sides: ClassicTeam[] = ['red', 'blue'];
        const randInt = (n: number) => Math.floor(Math.random() * n);
        const shuffle = <T>(arr: T[]): T[] => {
          const a = arr.slice();
          for (let i = a.length - 1; i > 0; i--) {
            const j = randInt(i + 1);
            [a[i], a[j]] = [a[j], a[i]];
          }
          return a;
        };

        const keys = (players ?? []).map(p => `p#${String(p.id)}`);

        if (env.G.activeTeam === null) {
          // ── Full randomize (lobby) ──
          (env.G.teams as any).operatives.red = {};
          (env.G.teams as any).operatives.blue = {};
          (env.G.teams as any).spymasters.red = {};
          (env.G.teams as any).spymasters.blue = {};

          const shuffled = shuffle(keys);
          let sideIdx = randInt(2);

          // First two players become spymasters
          if (shuffled.length >= 1) {
            (env.G.teams as any).spymasters[sides[sideIdx]][shuffled[0]] = true;
            sideIdx = (sideIdx + 1) % 2;
          }
          if (shuffled.length >= 2) {
            (env.G.teams as any).spymasters[sides[sideIdx]][shuffled[1]] = true;
            sideIdx = (sideIdx + 1) % 2;
          }

          // Remaining players become operatives, alternating teams
          for (let i = 2; i < shuffled.length; i++) {
            (env.G.teams as any).operatives[sides[sideIdx]][shuffled[i]] = true;
            sideIdx = (sideIdx + 1) % 2;
          }
        } else {
          // ── Partial randomize (keep spymasters) ──
          const existingSpymasters = new Set<string>([
            ...Object.keys((env.G.teams as any).spymasters.red ?? {}),
            ...Object.keys((env.G.teams as any).spymasters.blue ?? {}),
          ]);

          (env.G.teams as any).operatives.red = {};
          (env.G.teams as any).operatives.blue = {};

          const redSpyCount = Object.keys((env.G.teams as any).spymasters.red ?? {}).length;
          const blueSpyCount = Object.keys((env.G.teams as any).spymasters.blue ?? {}).length;

          // Start filling operatives on the side that has fewer spymasters
          let sideIdx =
            redSpyCount < blueSpyCount ? 0 : blueSpyCount < redSpyCount ? 1 : randInt(2);

          const unassigned = shuffle(keys.filter(k => !existingSpymasters.has(k)));
          for (const key of unassigned) {
            (env.G.teams as any).operatives[sides[sideIdx]][key] = true;
            sideIdx = (sideIdx + 1) % 2;
          }
        }

        cleanTips(env as unknown as ClassicGameEnv);
      },
    },

    // ── Game start ──────────────────────────────────────────────────────────

    startMatch: {
      client: false,
      sanitizeArgs: ([words, _player, config]: [Array<{ word: string }>, any, any]) => [
        words.map(w => ({ ...w, word: sanitizeTextInput(w.word, 36) })),
        _player,
        config,
      ],
      move: (
        env,
        words: Array<{ word: string; packName: string; packSize: number }>,
        _player: any,
        config: ClassicGridConfig = defaultGridConfig
      ) => {
        if (env.G.cardsDealed) return INVALID_MOVE;

        const result = startMatch(env as unknown as ClassicGameEnv, words, config);
        if (result === INVALID_MOVE) return INVALID_MOVE;

        env.events.setPhase('game');
        updateTimerValue(env as any, ['spymaster', 'extraTime', 'startAnimation']);
      },
    },

    // ── In-game moves ────────────────────────────────────────────────────────

    /**
     * Spymaster gives a clue word + number.
     * Sets guessLimit = clueNumber + 1 (or null for unlimited when number is 0).
     * Switches activeRole to 'operatives'.
     */
    giveClue: {
      client: false,
      sanitizeArgs: ([clue, player, selectedWords]: [any, any, any]) => {
        console.log('sanitizeArgs', clue, player, selectedWords);
        const word = sanitizeTextInput(clue.word, 32);
        const number = sanitizeClueNumberInput(clue.number);
        console.log('sanitizeArgs.result', word, number);
        return [{ word, number }, player, selectedWords];
      },
      move: (env, clue: { word: string; number: string }, player: any, selectedWords?: string[]) => {
        if (
          !isPlayersTurn(env as unknown as ClassicGameEnv) ||
          env.G.activeRole !== 'spymasters' ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }

        env.log.setMetadata({
          playerID: env.playerID,
          playerName: player.name,
          playerImage: player.image,
          playerTeam: env.G.activeTeam,
          selectedWords: selectedWords ?? [],
        });

        // guessLimit = clueNumber + 1 (the +1 "bonus" guess), or null for ∞
        const numericNumber = Number(clue.number);
        const guessLimit =
          numericNumber !== 0 && Number.isInteger(numericNumber)
            ? numericNumber + 1
            : null;

        env.G.guessLimit = guessLimit;
        env.G.activeRole = 'operatives';
        updateTimerValue(env as any, ['operative', 'giveClueAnimation']);
      },
    },

    /**
     * Operative guesses a card by word.
     *  - Correct (activeTeam color): reveal, decrement guessLimit, end turn if limit reached
     *  - Wrong team color: reveal, end turn
     *  - Neutral: reveal, end turn
     *  - Black (assassin): reveal, gameover (other team wins)
     */
    guessCard: {
      client: false,
      move: (env, word: string, player: any) => {
        if (
          !isPlayersTurn(env as unknown as ClassicGameEnv) ||
          env.G.guessLimit === 0 ||
          env.G.activeRole !== 'operatives' ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }

        let alreadyRevealed = false;
        let logMeta: Record<string, unknown> = {};

        env.G.grid = (env.G.grid as any[]).map((card: any) => {
          if (card.word !== word) return card;

          if (card.revealed) {
            alreadyRevealed = true;
            return card;
          }

          logMeta = {
            playerID: env.playerID,
            playerName: player.name,
            playerImage: player.image,
            playerTeam: env.G.activeTeam,
            cardColor: card.color,
            guessLimit: false,
          };

          card.tips = {};
          card.revealed = true;
          placeCoverToken(env as unknown as ClassicGameEnv, card);

          if (card.color === 'black') {
            // Assassin — the OTHER team wins
            const winner: ClassicTeam = env.G.activeTeam === 'red' ? 'blue' : 'red';
            setGameover(env as unknown as ClassicGameEnv, winner, 'assassin');
          } else if (card.color !== env.G.activeTeam) {
            // Wrong team or neutral — end turn immediately
            endTeamTurn(env as unknown as ClassicGameEnv, ['badGuessAnimation']);
          } else {
            // Correct guess — decrement limit
            if (env.G.guessLimit !== null) {
              env.G.guessLimit = env.G.guessLimit - 1;
            }
            if (env.G.guessLimit === 0) {
              endTeamTurn(env as unknown as ClassicGameEnv, ['limitGuessAnimation']);
              logMeta.guessLimit = true;
            }
          }

          return card;
        }) as any;

        env.log.setMetadata(logMeta);

        if (alreadyRevealed) return INVALID_MOVE;

        checkScoreWin(env as unknown as ClassicGameEnv);
      },
    },

    /**
     * Operatives voluntarily end their guessing phase.
     */
    endGuessing: {
      client: false,
      move: (env, player: any) => {
        if (
          !isPlayersTurn(env as unknown as ClassicGameEnv) ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }

        env.log.setMetadata({
          playerID: env.playerID,
          playerName: player.name,
          playerImage: player.image,
          playerTeam: env.G.activeTeam,
        });

        // -1 signals "ended voluntarily" (distinct from 0 = limit reached)
        env.G.guessLimit = -1;
        endTeamTurn(env as unknown as ClassicGameEnv, ['endGuessingAnimation']);
      },
    },

    /**
     * Toggle a tip marker on a card (operative pointing aid).
     * Only available while operatives are guessing.
     */
    tipCard: {
      client: false,
      redact: true,
      ignoreStaleStateID: true,
      move: (env, word: string) => {
        if (
          (!isPlayersTurn(env as unknown as ClassicGameEnv) &&
            env.G.activeRole !== 'operatives') ||
          env.G.gameover !== null
        ) {
          return INVALID_MOVE;
        }

        const key = `p#${env.playerID}`;
        env.G.grid = (env.G.grid as any[]).map((card: any) => {
          if (card.word === word) {
            if (card.tips[key]) delete card.tips[key];
            else card.tips[key] = true;
          }
          return card;
        }) as any;
      },
    },
  },

  // ── playerView ─────────────────────────────────────────────────────────────
  // Hides card colors from operatives (and from spectators) until revealed.
  // Spymasters always see all colors. Once the game is over everyone sees all.
  playerView: ({
    G,
    ctx,
    playerID,
  }: {
    G: GameStateClassic;
    ctx: any;
    playerID: string | null;
  }) => {
    if (
      !G.teams?.operatives?.red ||
      !G.teams?.operatives?.blue
    ) {
      console.warn('[playerView] CLASSIC called with incompatible game state');
      return G;
    }

    const { role } = getPlayerTeamRole(G, playerID ?? '');

    const filteredG = {
      ...G,
      grid: (G.grid as any[]).map((card: any) => ({
        ...card,
        // Spymasters, revealed cards, and post-game always show the real color
        color:
          role === 'spymasters' || card.revealed || G.gameover
            ? card.color
            : null,
      })),
    };

    // banBuffer is only available in the lobby phase
    if (ctx.phase !== 'lobby') {
      delete (filteredG as any).banBuffer;
    }

    return filteredG;
  },
} as Game<GameStateClassic>;