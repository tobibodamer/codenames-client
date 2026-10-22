// ─── Core domain enums ────────────────────────────────────────────────────────

import { ClientOpts, ClientState } from "boardgame.io/dist/types/src/client/client";
import { CodenamesTransport, CodenamesTransportOpts } from "./transport/CodenamesSocketIO";
import { getRandomSelectedAndRest } from "./game/utils";
import { FilteredMetadata, PlayerID } from "boardgame.io";

export type GameName = 'cno2' | 'cnduet';
export type DuetTeam = 'side1' | 'side2';
export type ClassicTeam = 'red' | 'blue';

export type Team = DuetTeam | ClassicTeam
export type Role = 'spymasters' | 'operatives';
export type CardColor = 'green' | 'red' | 'blue' | 'black' | 'neutral';
export type GameoverReason = 'score' | 'assassin' | 'time';
type CardLocationClassic = 'redDeck' | 'blueDeck' | 'grid';
type CardLocationDuet = 'greenDeck' | 'offscreenDeck' | 'grid';
export type CardLocation = CardLocationClassic | CardLocationDuet;
export type TokenLocation = 'timerDeck' | 'offscreenDeck' | 'grid';
export type GamePhase = 'lobby' | 'game' | 'gameover' | null;

// ─── Grid ─────────────────────────────────────────────────────────────────────

/**
 * Server-side card representation (spymaster view, never sent to clients directly).
 * The `playerView` strips this to `GridCard` per player.
 */
export interface GridCardFull {
  index: number;
  word: string;
  /** Per-team color assignments — only visible server-side */
  colors: Record<Team, CardColor>;
  revealed: Record<Team, boolean>;
  selected: boolean;
  /** Keys are "p#<playerID>", value is always `true` */
  tips: Record<string, true>;
}

/**
 * Card as received by a connected player (operative view).
 * `color` is already filtered to the player's own team via `playerView`.
 */
export interface GridCard {
  index: number;
  word: string;
  /** This player's team's color for this card (null if not on a team) */
  color: CardColor | null;
  revealed: any;
  selected: boolean;
  /** Keys are "p#<playerID>", value is always `true` */
  tips: Record<string, true>;
}

export interface GridCardDuet extends GridCard {
  revealed: Record<Team, boolean>;
}

/**
 * Classic grid card — simpler than Duet:
 * - `color` is a single value (one grid, one truth), hidden from operatives via playerView
 * - `revealed` is a plain boolean (not per-team)
 */
export interface GridCardClassic extends GridCard {  
  color: CardColor | null; // null when hidden from operatives
  revealed: boolean;
}

/**
 * Server-side classic card (full color always present).
 */
export interface GridCardClassicFull extends GridCardClassic {
  color: CardColor;
}


// ─── Cover cards & timer tokens ───────────────────────────────────────────────

export interface CoverCard {
  index: number;
  color: CardColor;
  location: CardLocation;
  gridIndex: number | null;  
  /** Only set in Duet */
  teamPlaced?: Team | null;
}

export interface TimerToken {
  index: number;
  location: TokenLocation;
  gridIndex: number | null;
  teamPlaced: Team | null;
}

// ─── Suggestions (spymaster pre-clue communication) ───────────────────────────

export interface Suggestion {
  id: string;
  word: string;
  number: number;
  /** Words the suggester thinks relate to this clue */
  words: string[];
  originalNumber?: number;
  author: PlayerInfo;
  /** Keys are "p#<playerID>" */
  likes: Record<string, true>;
  /** Keys are warning category strings, values are "p#<playerID>" arrays */
  warnings: Record<string, string[]>;
}

export interface Clue {
  word: string,
  number: string,
  suggestionID?: string
}

// ─── Game state (G) ───────────────────────────────────────────────────────────

export interface GameState {
  activeTeam: Team | null;
  activeRole: Role | null;
  grid: GridCard[];
  coverCards: CoverCard[];
  timerTokens: TimerToken[];
  remainingCards: Record<string, number>;
  cardsDealed: boolean;
  gameover: { reason: GameoverReason } | null;
  lockTeams: boolean;
  teams: Record<string, Record<string, any>>;
  suggestions: Record<string, Suggestion[]>;
  /** Only present in lobby phase */
  banBuffer?: Record<string, string[]>;
  timer: TimerState;
}

export interface GameStateClassic extends GameState {
  /** Which team had 9 cards (chosen randomly at startMatch) */
  startingTeam: ClassicTeam | null;
  activeTeam: ClassicTeam | null;
  /** null before the first clue is given (initial lobby/setup state) */
  activeRole: Role | null;
  grid: GridCardClassic[];
  /** Classic has no timer tokens */
  timerTokens: [];
  /** Classic has no remainingCards tracking in G — win is checked via coverCards */
  remainingCards: Record<ClassicTeam, number>;
  /**
   * null  = unlimited (clue number was 0/∞)
   * n > 0 = guesses remaining (initialised to clueNumber + 1, decremented on hit)
   * -1    = endGuessing was called
   */
  guessLimit: number | null;
  gameover: { reason: GameoverReason; team: ClassicTeam } | null;
  /** Nested: role → team → playerKey → true */
  teams: Record<Role, Record<ClassicTeam, Record<PlayerID, true>>>;
  /** Classic has no suggestions panel */
  suggestions: Record<string, never>;
}


export type GameStateDuet = GameState & {
  grid: GridCardDuet[];
  activeTeam: DuetTeam | null;
  teams: Record<DuetTeam, Record<PlayerID, true>>;
}

export interface TimerState {
  ts?: number;
  value?: number;
  running?: boolean;
}

// ─── Grid size config (passed as 3rd arg to startMatch in Classic) ────────────

export interface ClassicGridConfig {
  /** Cards for the starting (9-card) team */
  startingTeam: number;
  /** Cards for the other (8-card) team */
  otherTeam: number;
  /** Neutral cards */
  neutral: number;
  /** Assassin cards (almost always 1) */
  assasin: number;
}


// ─── Ctx ──────────────────────────────────────────────────────────────────────

export interface GameCtx {
  numPlayers: number;
  turn: number;
  currentPlayer: string;
  phase: GamePhase;
  numMoves: number;
  gameover?: { reason: GameoverReason };
  activePlayers: Record<string, null>;
}

// ─── Player metadata ──────────────────────────────────────────────────────────

export interface PlayerMeta {
  id: number;
  name?: string;
  isHost?: boolean;
  isConnected?: boolean;
}

export interface PlayerInfo {
  id?: string | number;
  playerID: string;
  name: string;
  image?: string | null;
  team?: Team | null;
  role?: Team | Role | null; // in Duet the role field mirrors team
  isConnected?: boolean;
  isHost?: boolean;
}

// ─── Full synced client state ─────────────────────────────────────────────────

export type CodenamesClientState = ClientState<GameState> & {
  setupData: SetupData;
  gameName?: GameName;
  servertime?: number;
  syncError?: string;
  roomTimeout?: boolean;
  roomID?: string | null;
  matchID?: string;
}

// ─── Setup / lobby config ─────────────────────────────────────────────────────

export type SetupData = SetupDataClassic | SetupDataDuet

export interface SetupDataDuet {
  wordLanguage: string;
  wordPacks: string[];
  defaultPacks: boolean;
  mode: 'normal' | string;
  timer: TimerConfig;
  teams?: { side1: Record<string, boolean>; side2: Record<string, boolean>; };
  banBuffer?: Record<string, string[]>;
}

export interface SetupDataClassic {
  wordLanguage: string;
  wordPacks: string[];
  defaultPacks: boolean;
  mode: 'normal' | string;
  timer: TimerConfig;
  teams?: {
    red: { operatives: Record<string, boolean>; spymasters: Record<string, boolean> };
    blue: { operatives: Record<string, boolean>; spymasters: Record<string, boolean> };
  };
  banBuffer?: Record<string, string[]>;
}

export interface TimerConfig {
  variant: 'off' | 'spymaster' | 'operative' | 'both';
  spymasterTimer: number;
  operativeTimer: number;
  extraTime: number;
}

// ─── Word entry (for startMatch) ──────────────────────────────────────────────

export interface WordEntry {
  word: string;
  packSize: number;
  packName: string;
  packType: 'base' | string;
  mix: 'add' | string;
}

// ─── Client constructor options ───────────────────────────────────────────────

export interface CodenamesClientOptions extends ClientOpts {
  /** boardgame.io matchID */
  matchID?: string;
  /** boardgame.io playerID (numeric string: "0", "1", …) */
  playerID?: string;
  /** Auth credential token received on join */
  credentials?: string;
  /** Room ID (short human-readable room code, or null/undefined when creating a new room) */
  roomID?: string | null;
  /** Display name */
  playerName: string;
  playerImage?: string | null;
  /** IETF locale, e.g. "de", "en" */
  playerLocale?: string;
  onJoinMatch?: (args: { playerID: string; credentials: string }) => void;
  multiplayer: (transportOpts: CodenamesTransportOpts) => CodenamesTransport;
}

export type MatchData = (FilteredMetadata[number] & {
  isHost?: boolean
  image?: string | null
})[]