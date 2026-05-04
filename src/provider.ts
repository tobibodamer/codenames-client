// ─── Socket / server config ───────────────────────────────────────────────────

import { Ctx, Game, PlayerID } from "boardgame.io";
import { Client, ClientState } from "boardgame.io/dist/types/src/client/client";
import { BehaviorSubject, distinctUntilChanged, map, NEVER, Observable, of, Subscription, switchMap } from "rxjs";
import { DerivedState, computeDerivedState, defaultDerivedState } from "./helpers";
import { GameState, MatchData, CodenamesClientState, SetupData, CodenamesClientOptions, GameName } from "./types";
import { ClientImpl } from "./client";
import { CodenamesSocketIO } from "./transport/CodenamesSocketIO";
import { generateCredentials, generateRoomId } from "./slug";
import { CNDuetGame } from "./game/duet/CNDuetGame";
import { CNClassicGame } from "./game/classic/CNDiscordGame";


export interface SocketParams {
  server: string;
  socketOpts: {
    path: string;
    transports: string[];
  };
}

export interface CNProviderConfig {
  /** Base URL of the boardgame.io server, e.g. "https://my-server.com" */
  serverURL: string;
  /** Optional socket.io path prefix, e.g. "/api" */
  serverPath?: string;
  /** Which game definition to use: "cno2" | "cnduet" */
  gameName?: GameName;
  /** Whether to disable animation middleware */
  noAnimation?: boolean;
  /** Any extra options forwarded to boardgame.io Client() */
  clientOpts: {
    /** boardgame.io matchID */
    matchID?: string;
    /** boardgame.io playerID (numeric string: "0", "1", …) */
    playerID?: string;
    /** Auth credential token received on join */
    credentials: string;
    /** Room ID (short human-readable room code) */
    roomID?: string;
    /** Display name */
    playerName: string;
    playerImage?: string | null
    /** IETF locale, e.g. "de", "en" */
    playerLocale?: string;
  }
  /** Optional function to compute derived state on every update */
  computeDerivedState?: (args: {
    client: CodenamesClientState | null
    G: GameState | null,
    ctx: Ctx | null,
    playerID?: PlayerID | null,
    matchData?: MatchData | null,
    gameName?: GameName,
  }) => DerivedState;
  /** Optional function to compute server time delta */
  calcServerDelta?: (servertime: number | undefined) => number | undefined;
}

// ─── Game registry ────────────────────────────────────────────────────────────

/**
 * Register your boardgame.io game definitions here.
 * The factory function pattern mirrors the original `g()` call.
 */
export type GameFactory = () => Game;

const gameRegistry: Record<string, GameFactory> = {};

export function registerGame(key: string, factory: GameFactory): void {
  gameRegistry[key] = factory;
}

function resolveGame(gameName: string): GameFactory {
  const factory = gameRegistry[gameName] ?? gameRegistry["cnduet"];
  if (!factory) {
    throw new Error(
      `No game registered for "${gameName}". Call registerGame() first.`
    );
  }
  return factory;
}

registerGame("cnduet", () => CNDuetGame)
registerGame("cno2", () => CNClassicGame)

// ─── Initial state ────────────────────────────────────────────────────────────

export type ProviderState = {
  client: ClientImpl | null
  G: GameState | null,
  ctx: Ctx | null,
  _stateID: number,
  playerID?: PlayerID | null,
  matchData?: MatchData | null,
  //servertimedelta: calcServerTimeDelta,
  isConnected: boolean,
  gameName: GameName,
  setupData: SetupData | null,
  syncError: string | null,
  roomTimeout?: boolean,
  derived: DerivedState,
}

const INITIAL_STATE: ProviderState = {
  client: null,
  G: null,
  ctx: null,
  _stateID: 0,
  playerID: null,
  matchData: null,
  isConnected: false,
  gameName: "cnduet",
  setupData: null,
  syncError: null,
  derived: defaultDerivedState,
};

/**
 * Node.js / RxJS equivalent of the React BGIOProvider + ClientManager.
 */
export class CodenamesProvider {
  // ── Public reactive state ──────────────────────────────────────────────────

  /** Full reactive state stream. */
  private readonly _state$: BehaviorSubject<ProviderState>;

  get state$() { return this._state$.asObservable(); }
  get state() { return this._state$.value; }

  /** Convenience selector helper — emits only when the selected slice changes. */
  select<T>(selector: (s: ProviderState) => T): Observable<T> {
    return this._state$.pipe(map(selector), distinctUntilChanged());
  }

  // ── Private fields ─────────────────────────────────────────────────────────

  public config: CNProviderConfig;

  /**
   * The single top-level subscription that drives the switchMap pipeline.
   * Cancelling it stops everything — equivalent to the useEffect cleanup
   * returning `() => { r(); e.stop() }`.
   */
  private rootSubscription: Subscription | null = null;


  constructor(config: CNProviderConfig) {
    this.config = config;
    this._state$ = new BehaviorSubject<ProviderState>({
      ...INITIAL_STATE,
      gameName: config.gameName || "cnduet",
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start the boardgame.io client and subscribe to state updates. */
  start(): void {
    if (this.rootSubscription) return; // already running

    const socketParams = this.buildSocketParams();

    const gameName$ = this.select(s => s.gameName)

    // switchMap tears down the previous inner subscription (stops the old
    // bgioClient) and creates a new one whenever gameName$ emits.
    this.rootSubscription = gameName$
      .pipe(
        switchMap((gameName) => gameName ?
          new Observable<CodenamesClientState | null>((subscriber) => {
            const game = resolveGame(gameName)();

            const clientOpts: CodenamesClientOptions = {
              game: game,
              debug: false,
              numPlayers: 64,
              matchID: "default",
              roomID: generateRoomId(),
              multiplayer: CodenamesSocketIO(socketParams),
              ...(this.config.clientOpts),
            };

            const client = new ClientImpl(clientOpts);

            this._state$.next({
              ...this._state$.getValue(),
              client: client
            })

            client.start();

            // Mirror: `r = e.subscribe(r => { … })`
            const unsubscribe = client.subscribe(
              (clientState: CodenamesClientState | null) => {
                subscriber.next(clientState);
              },
            );

            // Mirror: `return () => { r && r(); e && e.stop() }`
            // Called by switchMap when gameName changes or rootSubscription
            // is unsubscribed (i.e. stop() is called).
            return () => {
              unsubscribe();
              client.stop();
            };
          })
          : NEVER),
      )
      .subscribe((clientState) => {
        this.handleClientUpdate(clientState);
      });
  }

  /** Stop the client, unsubscribe from all streams, and clean up. */
  stop(): void {
    this.rootSubscription?.unsubscribe();
    this.rootSubscription = null;

  }

  /** Patch the current state (mirrors the Zustand `update` action). */
  update(patch: Partial<ProviderState>): void {
    this._state$.next({ ...this._state$.getValue(), ...patch });
  }

  /** Expose the underlying boardgame.io client for direct moves / actions. */
  getBGIOClient(): ClientImpl | null {
    return this._state$.value.client;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildSocketParams(): SocketParams {
    const { serverURL, serverPath = "" } = this.config;
    return {
      server: serverURL || "/",
      socketOpts: {
        path: `${serverPath}/socket.io`,
        transports: ["websocket"],
      },
    };
  }

  private handleClientUpdate(newClientState: CodenamesClientState | null): void {
    const state = this._state$.getValue()
    const client = state.client

    if (!client) return
    const clientState = client.getState()

    // ── syncError branch ──────────────────────────────────────────────────
    if (client.syncError) {
      this._state$.next({
        ...state,
        syncError: client.syncError as string,
        isConnected: true,
      });
      return;
    }

    // ── roomTimeout branch ────────────────────────────────────────────────
    if (client.roomTimeout) {
      this._state$.next({
        ...state,
        roomTimeout: true,          // stored outside LocalState if needed
        isConnected: false,
      });
      return;
    }

    // ── normal update branch ──────────────────────────────────────────────
    if (clientState && newClientState) {
      const { computeDerivedState, calcServerDelta } = this.config;

      const derived: DerivedState = computeDerivedState
        ? computeDerivedState({
          G: clientState.G,
          ctx: clientState.ctx,
          playerID: client.playerID,
          matchData: client.matchData,
          gameName: newClientState.gameName ?? state.gameName,
          client: newClientState,
        })
        : defaultDerivedState;

      const next: ProviderState = {
        client,
        G: clientState.G,
        ctx: clientState.ctx,
        _stateID: clientState._stateID ?? 0,
        playerID: client.playerID,
        matchData: client.matchData,
        isConnected: newClientState.isConnected ?? false,
        gameName: newClientState.gameName ?? state.gameName,
        setupData: newClientState.setupData ?? null,
        syncError: null,
        derived,
        ...(calcServerDelta && newClientState.servertime !== undefined
          ? { servertimedelta: calcServerDelta(newClientState.servertime) }
          : {}),
      };

      this._state$.next(next);
    }
  }
}

// ─── Factory / singleton helpers ──────────────────────────────────────────────

const createProviderConfig = (): CNProviderConfig => {
  return {
    /** Base URL of the boardgame.io server, e.g. "https://my-server.com" */
    serverURL: "https://server-discord.gke.codenames.game",

    /** Which game definition to use: "cno2" | "cnduet" */
    gameName: "cnduet",

    /** Any extra options forwarded to boardgame.io Client() */
    clientOpts: {
      credentials: generateCredentials(),
      playerName: "",
      playerLocale: "de",
      matchID: "default",
      roomID: generateRoomId(),
    },

    computeDerivedState
  }
}

export function createCodenamesProvider(config: Partial<CNProviderConfig>): CodenamesProvider {
  return new CodenamesProvider({ ...createProviderConfig(), ...config, });
}
