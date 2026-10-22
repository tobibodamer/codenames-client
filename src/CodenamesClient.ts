import { LogEntry } from "boardgame.io";
import {
  BehaviorSubject,
  concatAll,
  map,
  Observable,
} from "rxjs";
import { EventEmitter } from "stream";
import { ClientImpl } from "./client";
import { getCurrentPlayer, getPlayerInfo, getPlayerTeamRole } from "./helpers";
import type {
  Clue,
  CodenamesClientState,
  GameState,
  PlayerInfo,
  Role,
  SetupData,
  Team,
  WordEntry,
} from "./types";


export class CodenamesClient extends EventEmitter<{
  joinMatch: [{ playerID: string; credentials: string }];
}> {
  private readonly bgio;

  private readonly _clientState$ =
    new BehaviorSubject<CodenamesClientState | null>(null);

  readonly players$: Observable<PlayerInfo[]> = this._clientState$.pipe(
    map((s) => this.bgio.matchData?.map(meta => getPlayerInfo({ meta, playerID: String(meta.id), G: s?.G })) ?? []),
  );

  readonly connectionState$: Observable<boolean> = this._clientState$.pipe(
    map((s) => s?.isConnected === true),
  );
  readonly logEntries$: Observable<LogEntry>;
  readonly game$: Observable<GameState | null> = this._clientState$.pipe(
    map((s) => s?.G ?? null),
  );

  get currentPlayer(): PlayerInfo | null {
    return getCurrentPlayer({ playerID: this.bgio.playerID, matchData: this.bgio.matchData, G: this._clientState$.value?.G })
  }

  get game(): GameState | null { return this._clientState$.value?.G ?? null; }

  constructor(bgioClient: ClientImpl) {
    super();

    this.bgio = bgioClient;
    this.bgio.subscribe((state) => this._clientState$.next(state));
    this.logEntries$ = this.bgio.deltalog$.pipe(concatAll())
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Connect to the server and start receiving state updates. */
  connect(): Promise<void> {
    if (this.isConnected) {
      return Promise.resolve();
    }

    if (!this.bgio.running) {
      this.bgio.start();
    }

    return new Promise<void>((resolve) => {
      const unsub = this.bgio.subscribe((state) => {
        if (state?.isConnected) {
          resolve();
          unsub();
        }
      });
    });
  }

  /**
   * Wait until the client receives a fully synchronized game state.
   */
  waitForSync(timeoutMs: number = 20000): Promise<CodenamesClientState> {
    return new Promise((resolve, reject) => {
      const currentState = this.state;
      if (currentState?.G && currentState.isConnected) {
        return resolve(currentState);
      }
      if (currentState?.syncError) {
        return reject(new Error(`Sync error: ${currentState.syncError}`));
      }

      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for sync`));
      }, timeoutMs);

      const unsub = this.subscribe((state) => {
        if (state?.syncError) {
          clearTimeout(timer);
          unsub();
          reject(new Error(`Sync error: ${state.syncError}`));
        } else if (state?.roomTimeout) {
          clearTimeout(timer);
          unsub();
          reject(new Error('Room timed out'));
        } else if (state?.G && state.isConnected) {
          clearTimeout(timer);
          unsub();
          resolve(state);
        }
      });
    });
  }

  /** Disconnect and stop all background intervals. */
  disconnect(): void {
    this.bgio.stop();
  }

  /**
   * Subscribe to state changes.
   * The callback is called immediately with the current state, then on every update.
   * Returns an unsubscribe function.
   */
  subscribe(
    callback: (state: CodenamesClientState | null) => void,
  ): () => void {
    return this.bgio.subscribe((state) => {
      callback(state);
    });
  }

  /** Get the current state snapshot synchronously. */
  get state() {
    return this._clientState$.value
  }

  // ── Lobby moves ────────────────────────────────────────────────────────────

  /** Join a team. Can be called before or after a game (allowAfterGameover). */
  joinTeam(team: Team, role?: Role): void {
    if (this.bgio.gameName === "cno2") {
      if (!role) {
        throw new Error("Role must be specified in Classic Codenames!")
      }

      this.bgio.moves.joinTeam(team, role);
    } else {
      this.bgio.moves.joinTeam(team);
    }
  }

  /** Leave your current team. */
  leaveTeam(): void {
    this.bgio.moves.leaveTeam();
  }

  /** Lock / unlock team switching (host only). */
  setLockTeams(locked: boolean): void {
    this.bgio.moves.setLockTeams(locked);
  }

  /** Clear all teams. */
  resetTeams(): void {
    this.bgio.moves.resetTeams();
  }

  /**
   * Randomly distribute `players` between side1 and side2.
   * @param players Array of { id: number } objects from filteredMetadata
   */
  randomizeTeams(players: Array<{ id: number }>): void {
    this.bgio.moves.randomizeTeams(players);
  }

  /**
   * Start the game. Called by the host after teams are set.
   * `words` should be an array of 25 WordEntry objects (fetched from the
   * codenames content API or provided by you).
   */
  startMatch(words: WordEntry[]): void {
    this.bgio.moves.startMatch(words);
  }

  // ── In-game moves ──────────────────────────────────────────────────────────

  /**
   * Give a clue as spymaster.
   * @param clue The clue
   * @param player  Your PlayerInfo (from state metadata + your team info)
   * @param selectedWords  Words you pre-selected to communicate intent (can be [])
   */
  giveClue(
    clue: Clue,
    player?: PlayerInfo,
    selectedWords: string[] = [],
  ): void {
    player ??= this.currentPlayer ?? undefined
    if (!player) {
      throw new Error("No player found")
    }

    this.bgio.moves.giveClue(
      clue,
      player ?? this.currentPlayer,
      selectedWords,
    );
  }

  /**
   * Toggle a tip marker on a card (operative communication).
   * Calling with the same word a second time removes the tip.
   */
  tipCard(word: string): void {
    this.bgio.moves.tipCard(word);
  }

  /**
   * Guess a card as operative.
   * @param word  The word on the card
   * @param player  Your PlayerInfo (defaults to currentPlayer)
   */
  guessCard(word: string, player?: PlayerInfo): void {
    const p = player ?? this.currentPlayer;
    if (!p) throw new Error("No player found");
    this.bgio.moves.guessCard(word, p);
  }

  /**
   * End your guessing turn voluntarily (discards a timer token and switches roles).
   * @param player  Your PlayerInfo (defaults to currentPlayer)
   */
  endGuessing(player?: PlayerInfo): void {
    const p = player ?? this.currentPlayer;
    if (!p) throw new Error("No player found");
    this.bgio.moves.endGuessing(p);
  }

  // ── Suggestion moves ───────────────────────────────────────────────────────

  /**
   * Add a clue suggestion for your team to vote on before giving the real clue.
   * @param word  Suggested clue
   * @param number  Suggested count
   * @param relatedWords  Cards you think this clue covers
   * @param player  Your PlayerInfo (defaults to currentPlayer)
   */
  addSuggestion(
    word: string,
    number: number,
    relatedWords: string[],
    player?: PlayerInfo,
  ): void {
    const p = player ?? this.currentPlayer;
    if (!p) throw new Error("No player found");
    this.bgio.moves.addSuggestion(
      { word, number, words: relatedWords },
      p,
    );
  }

  /**
   * Remove a suggestion you previously added.
   * @param id  Suggestion id
   * @param team  The team whose suggestion list to remove from
   */
  removeSuggestion(id: string, team: Team): void {
    this.bgio.moves.removeSuggestion(id, team);
  }

  /**
   * Toggle a like on a suggestion.
   * @param id  Suggestion id
   * @param player  Your PlayerInfo (defaults to currentPlayer)
   */
  likeSuggestionToggle(id: string, player?: PlayerInfo): void {
    const p = player ?? this.currentPlayer;
    if (!p) throw new Error("No player found");
    this.bgio.moves.likeSuggestionToggle(id, p);
  }

  /**
   * Toggle a warning on a suggestion.
   * @param id  Suggestion id
   * @param player  Your PlayerInfo
   * @param warningType  Warning category string
   */
  warningSuggestionToggle(
    id: string,
    player: PlayerInfo,
    warningType: string,
  ): void {
    this.bgio.moves.warningSuggestionToggle(id, player, warningType);
  }

  // ── Transport-level actions ────────────────────────────────────────────────

  /**
   * Ask the server to redirect to the next match (called automatically by the
   * framework when the server emits `playNextMatch`, but can be triggered manually).
   */
  playAgain(): void {
    this.bgio.playAgain?.();
  }

  /**
   * Emit a joinMatch event over the socket (used for lobby joining via socket
   * rather than the REST API).
   * @param payload  Join metadata (playerName, credentials, roomID, etc.)
   */
  joinMatch(payload: Record<string, unknown>): void {
    this.bgio.joinMatch(payload);
  }

  /**
   * Update this client's setup data (host only, affects word language / packs / timer).
   * @param data  Partial SetupData to merge
   */
  updateSetupData(data: Record<string, unknown>): void {
    this.bgio.updateSetupData(data);
  }

  /**
   * Send a chat message.
   * @param text  Message text
   */
  sendChat(text: string): void {
    this.bgio.sendChatMessage(text);
  }

  /**
   * Force a sync with the server (useful after a detected stale state).
   */
  requestSync(): void {
    this.bgio.requestSync();
  }

  // ── Convenience helpers ────────────────────────────────────────────────────

  /** True when the socket is connected. */
  get isConnected(): boolean {
    return this.state?.isConnected ?? false;
  }

  /** True when it is this player's turn to act. */
  get isActive(): boolean {
    return this.bgio.getState()?.isActive ?? false;
  }

  /** Your playerID string. */
  get playerID(): string {
    return this.bgio.playerID!;
  }

  /** Your team, derived from current game state. */
  get myTeam(): Team | null {
    const state = this.state;
    if (!state) return null;

    return getPlayerTeamRole(state.G.teams, this.bgio.playerID!).team;
  }

  /** The room ID (e.g. "potaz-zuvaj") */
  get roomID(): string | null {
    return this.bgio.roomID ?? this.state?.roomID ?? null;
  }

  /** The match ID */
  get matchID(): string {
    return this.bgio.matchID;
  }

  /** The player credentials token */
  get credentials(): string {
    return this.bgio.credentials;
  }
}
