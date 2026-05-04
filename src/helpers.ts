import { Ctx, PlayerID } from "boardgame.io";
import { Clue, CodenamesClientState, DuetTeam, GameState, MatchData, PlayerInfo, Role, SetupData, Team } from "./types";

export interface DerivedState {
  currentPlayer: PlayerInfo | null;
  isMyTurn: boolean;
  playerAction: PlayerAction;
  isGuessingStage: boolean;    // operatives phase is active
  isClueGivingStage: boolean;  // spymasters phase is active
  inLobby: boolean;
  inGame: boolean;
  isGameOver: boolean;
  isSuddenDeath: boolean;      // Duet: both teams guessing simultaneously
  activePlayerIDs: string[];
  coveredCardIndices: Set<number>;
  timerTokenIndices: Set<number>;
  remainingCardsByTeam: Record<string, number>;
  lastClue: Clue | null;
  canEndGuessing: boolean;
  connectedPlayers: PlayerInfo[];
  spectators: PlayerInfo[];
}

type PlayerAction =
  | "game_over"
  | "waiting"
  | "spectating"
  | "giving_clue"
  | "guessing";

export const defaultDerivedState: DerivedState = {
  currentPlayer: null,
  isMyTurn: false,
  playerAction: "waiting",
  isGuessingStage: false,
  isClueGivingStage: false,
  inLobby: true,
  inGame: false,
  isGameOver: false,
  isSuddenDeath: false,
  activePlayerIDs: [],
  coveredCardIndices: new Set(),
  timerTokenIndices: new Set(),
  remainingCardsByTeam: {},
  lastClue: null,
  canEndGuessing: false,
  connectedPlayers: [],
  spectators: [],
};

/**
 * Look up a player's team and role from G.teams.
 * Handles both cno2 (red/blue × operatives/spymasters)
 * and cnduet (side1/side2, no sub-roles) structures.
 */
export function getPlayerTeamRole(
  teams: Record<string, Record<string, any>>,
  playerID: string
): { team: Team | null; role: Team | Role | null } {
  if (!teams || !playerID) return { team: null, role: null };

  const key = `p#${playerID}`;

  // cnduet: flat side1/side2 objects
  if (teams.side1 !== undefined && teams.side2 !== undefined) {
    for (const side of ["side1", "side2"] as const) {
      if (teams[side]?.[key]) return { team: side, role: side };
    }
    return { team: null, role: null };
  }

  // cno2: red/blue × operatives/spymasters
  for (const team of ["red", "blue"] as const) {
    if (teams[team]?.operatives?.[key]) return { team, role: "operatives" };
    if (teams[team]?.spymasters?.[key]) return { team, role: "spymasters" };
  }

  return { team: null, role: null };
}

/** Build a rich PlayerInfo object for the local player. */
export function getCurrentPlayer(state: { playerID?: PlayerID | null, matchData?: MatchData | null, G?: GameState | null }): PlayerInfo | null {
  const { playerID, matchData, G } = state;
  if (!playerID || !matchData) return null;

  const meta = matchData?.find(p => String(p.id) === playerID);
  if (!meta) return null;

  return getPlayerInfo({ playerID, meta, G })
}

/** Build a rich PlayerInfo object for a player from metadata. */
export function getPlayerInfo(state: { playerID: PlayerID, meta: MatchData[number], G?: GameState | null }): PlayerInfo {
  const { playerID, meta, G } = state;
  const { team, role } = G?.teams
    ? getPlayerTeamRole(G.teams, playerID)
    : { team: null, role: null };

  return {
    id: playerID,
    playerID,
    name: meta.name ?? `Player ${playerID}`,
    isConnected: meta.isConnected ?? true,
    isHost: meta.isHost ?? false,
    image: meta.image,
    team,
    role,
  };
}

/**
 * Determine what the local player should be doing right now.
 * Returns one of: "game_over" | "waiting" | "spectating" | "giving_clue" | "guessing"
 */
function getPlayerAction(
  state: { G: GameState | null, gameName: string },
  currentPlayer: PlayerInfo | null,
  inGame: boolean,
  isGameOver: boolean,
  isSuddenDeath: boolean
): PlayerAction {
  if (isGameOver) return "game_over";
  if (!currentPlayer || !inGame) return "waiting";
  if (currentPlayer.team === null) return "spectating";

  const { G, gameName } = state;
  const { activeTeam, activeRole, remainingCards } = G ?? {};

  if (gameName === "cno2") {
    const isActiveTeam = activeTeam === currentPlayer.team;
    const isActiveRole = activeRole === currentPlayer.role;
    if (isActiveTeam && isActiveRole) {
      return activeRole === "spymasters" ? "giving_clue" : "guessing";
    }
    return "waiting";
  }

  if (gameName === "cnduet") {
    // Spymasters give clues when their side still has cards remaining
    if (activeRole === "spymasters" && (remainingCards?.[currentPlayer.role as DuetTeam] ?? 0) > 0) {
      return "giving_clue";
    }
    // Operatives guess on their turn, or during sudden death if the other side has cards left
    if (activeRole === "operatives") {
      const isActiveTeam = activeTeam === currentPlayer.team;
      const otherSide = currentPlayer.team === "side1" ? "side2" : "side1";
      const otherSideHasCards = (remainingCards?.[otherSide] ?? 0) > 0;
      if (isActiveTeam || (isSuddenDeath && otherSideHasCards)) {
        return "guessing";
      }
    }
  }

  return "waiting";
}

/** IDs of all players currently in the active team+role slot. */
function getActivePlayerIDs(state: { G: GameState | null, gameName: string }): string[] {
  const { G, gameName } = state;
  const { activeRole, activeTeam, teams } = G ?? {};
  if (!activeRole || !activeTeam || !teams) return [];

  try {
    if (gameName === "cnduet") {
      // In Duet, the entire side is active (no sub-role)
      const side = teams[activeTeam];
      if (side) return Object.keys(side).map((k) => k.replace("p#", ""));
    } else {
      const slot = teams[activeTeam]?.[activeRole];
      if (slot) return Object.keys(slot).map((k) => k.replace("p#", ""));
    }
  } catch { }

  return [];
}

/** Derive card/token positions and remaining card counts from G. */
function getBoardState(state: { G: GameState | null }) {
  const { G } = state;
  const coveredCardIndices = new Set<number>();
  const timerTokenIndices = new Set<number>();
  const remainingCardsByTeam: Record<string, number> = {};

  for (const card of G?.coverCards ?? []) {
    if (card.location === "grid" && card.gridIndex != null) {
      coveredCardIndices.add(card.gridIndex);
    } else if (card.location !== "grid") {
      // Cards not on the grid are counted as remaining per team color
      remainingCardsByTeam[card.color] = (remainingCardsByTeam[card.color] ?? 0) + 1;
    }
  }

  for (const token of G?.timerTokens ?? []) {
    if (token.location === "grid" && token.gridIndex != null) {
      timerTokenIndices.add(token.gridIndex);
    }
  }

  return { coveredCardIndices, timerTokenIndices, remainingCardsByTeam };
}

/** Walk the log backwards to find the most recent giveClue move. */
function getLastClue(state: CodenamesClientState): Clue & { team?: Team | null, playerID?: PlayerID | null } | null {
  const log = state.log;
  if (!Array.isArray(log)) return null;

  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (
      entry?.action?.type === "MAKE_MOVE" &&
      entry?.action?.payload?.type === "giveClue"
    ) {
      const [clueArg, context]: [Clue, PlayerInfo] = entry.action.payload.args ?? [];
      if (clueArg) {
        return {
          word: clueArg.word,
          number: clueArg.number,
          team: context?.team,
          playerID: context?.id ? String(context.id) : undefined,
        };
      }
    }
  }
  return null;
}

/**
 * Determine whether the "end guessing" button should be available.
 *
 * cno2:  allowed after at least one correct guess, no wrong guesses, and
 *        the guess limit hasn't been reached yet.
 * cnduet: not allowed during sudden death; allowed after any correct (green) guess.
 */
function getCanEndGuessing(state: CodenamesClientState, isSuddenDeath: boolean): boolean {
  const log = state?.log;
  const { G, gameName } = state;
  if (!Array.isArray(log)) return false;

  // Find the index of the most recent giveClue entry
  let clueIndex = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (
      log[i]?.action?.type === "MAKE_MOVE" &&
      log[i]?.action?.payload?.type === "giveClue"
    ) {
      clueIndex = i;
      break;
    }
  }
  if (clueIndex === -1) return false;

  const entriesSinceClue = log.slice(clueIndex);

  if (gameName === "cno2") {
    let hasCorrectGuess = false;
    let reachedGuessLimit = false;
    let hasWrongGuess = false;

    for (const entry of entriesSinceClue) {
      if (
        entry?.action?.type === "MAKE_MOVE" &&
        entry?.action?.payload?.type === "guessCard"
      ) {
        const { cardColor, playerTeam, guessLimit } = entry.metadata ?? {};
        if (cardColor === playerTeam) {
          hasCorrectGuess = true;
          if (guessLimit) reachedGuessLimit = true;
        } else {
          hasWrongGuess = true;
        }
      }
    }

    return hasCorrectGuess && !reachedGuessLimit && !hasWrongGuess;
  }

  if (gameName === "cnduet") {
    if (isSuddenDeath) return false;
    return entriesSinceClue.some(
      (e: any) =>
        e?.action?.type === "MAKE_MOVE" &&
        e?.action?.payload?.type === "guessCard" &&
        e?.metadata?.cardColor === "green"
    );
  }

  return false;
}

/** All connected players, plus a separate spectators list (those with no team). */
function getConnectedPlayersAndSpectators(state: { matchData?: MatchData | null, G: GameState | null }) {
  const { matchData, G } = state;
  const connectedPlayers: PlayerInfo[] = [];
  const spectators: PlayerInfo[] = [];

  if (!matchData) return { connectedPlayers, spectators };

  for (const [id, meta] of Object.entries(matchData) as [string, MatchData[number]][]) {
    if (!meta || typeof meta !== "object" || !meta.name) continue;

    const player: PlayerInfo = {
      id,
      playerID: id,
      name: meta.name,
      isConnected: meta.isConnected ?? true,
      isHost: meta.isHost ?? false,
      image: meta.image,
    };

    connectedPlayers.push(player);

    const { team } = G?.teams
      ? getPlayerTeamRole(G.teams, id)
      : { team: null };

    if (team === null) {
      spectators.push({ ...player, team: null, role: null });
    }
  }

  return { connectedPlayers, spectators };
}

/** Master selector — computes the full DerivedState from a boardgame.io state snapshot. */
export function computeDerivedState(state: {
  client: CodenamesClientState | null,
  G: GameState | null,
  ctx: Ctx | null,
  playerID?: PlayerID | null,
  matchData?: MatchData | null,
  gameName?: string,
}): DerivedState {
  if (!state?.ctx) return defaultDerivedState;
  if (!state?.client) return defaultDerivedState;
  if (!state?.gameName) return defaultDerivedState;

  const { G, ctx, gameName, matchData } = state;

  const inLobby = ctx.phase === "lobby";
  const inGame = ctx.phase === "game";
  const isGameOver = ctx.phase === "gameover" || G?.gameover != null;

  // Duet "sudden death": both sides guess simultaneously when activeTeam is null
  const isSuddenDeath =
    gameName === "cnduet" &&
    G?.activeTeam === null &&
    G?.activeRole === "operatives";

  const isGuessingStage = inGame && G?.activeRole === "operatives";
  const isClueGivingStage = inGame && G?.activeRole === "spymasters";

  const currentPlayer = getCurrentPlayer(state);

  // Is it specifically this player's turn?
  let isMyTurn = false;
  if (currentPlayer?.team && inGame && !isGameOver) {
    if (gameName === "cno2") {
      isMyTurn = G?.activeTeam === currentPlayer.team;
    } else if (gameName === "cnduet") {
      const otherSide = currentPlayer.team === "side1" ? "side2" : "side1";
      isMyTurn =
        G?.activeTeam === currentPlayer.team ||
        (isSuddenDeath && (G?.remainingCards?.[otherSide] ?? 0) > 0);
    }
  }

  const playerAction = getPlayerAction({ G, gameName }, currentPlayer, inGame, isGameOver, isSuddenDeath);
  const activePlayerIDs = getActivePlayerIDs({ G, gameName });
  const { coveredCardIndices, timerTokenIndices, remainingCardsByTeam } = getBoardState(state);
  const lastClue = getLastClue(state.client);
  const canEndGuessing = getCanEndGuessing(state.client, isSuddenDeath);
  const { connectedPlayers, spectators } = getConnectedPlayersAndSpectators({ G, matchData });

  return {
    currentPlayer,
    isMyTurn,
    playerAction,
    isGuessingStage,
    isClueGivingStage,
    inLobby,
    inGame,
    isGameOver,
    isSuddenDeath,
    activePlayerIDs,
    coveredCardIndices,
    timerTokenIndices,
    remainingCardsByTeam,
    lastClue,
    canEndGuessing,
    connectedPlayers,
    spectators,
  };
}