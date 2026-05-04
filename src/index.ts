/**
 * codenames-duet-client
 *
 * Public API surface.
 */

export { CodenamesClient } from './CodenamesClient';
export { CodenamesSocketIO, codenamesGetServerURLAndPath } from './transport/CodenamesSocketIO';
export { CNDuetGame } from './game/duet/CNDuetGame';
export { getPlayerSide, getOtherDuetTeam, isDuetPlayersTurn } from './game/duet/helpers';
export { createCodenamesProvider, CNProviderConfig, ProviderState } from "./provider"
export { DerivedState, getPlayerInfo, getCurrentPlayer } from "./helpers"

export type {
  // Domain types
  Team,
  Role,
  CardColor,
  GameoverReason,
  CardLocation,
  TokenLocation,
  GamePhase,
  // State shapes
  GridCard,
  GridCardFull,
  CoverCard,
  TimerToken,
  Clue,
  Suggestion,
  GameState,
  GameCtx,
  CodenamesClientState,
  PlayerMeta,
  PlayerInfo,
  // Config
  SetupData,
  TimerConfig,
  WordEntry,
  CodenamesClientOptions
} from './types';