// Based on the boardgame.io client implementation.
// Copyright (c) 2017 The boardgame.io Authors.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
  createStore,
  compose,
  applyMiddleware,
  Middleware,
  Store,
} from 'redux';

import { ProcessGameConfig } from 'boardgame.io/internal';
import { InitializeGame } from 'boardgame.io/internal';
import { CreateGameReducer } from 'boardgame.io/internal';
import * as Actions from "./bgio/action-types"
import * as ActionCreators from './bgio/action-creators';
import { nanoid } from 'nanoid';
import { ActivePlayersArg, ChatMessage, PlayerID, Reducer, State, ActionShape, LogEntry } from 'boardgame.io';
import { CodenamesClientOptions, CodenamesClientState, GameName, GameState, MatchData } from './types';
import { CodenamesTransport, CodenamesTransportOpts } from './transport/CodenamesSocketIO';
import { ClientManager } from './bgio/manager';
import { Subject, Observable } from 'rxjs';
import { PlayerView } from './bgio/plugins/main';
import { generateCredentials } from './slug';

const { sync, update, patch, reset, undo, redo } = ActionCreators;


export const GlobalClientManager = new ClientManager();

/**
 * Standardise the passed playerID, using currentPlayer if appropriate.
 */
function assumedPlayerID(
  playerID: PlayerID | null | undefined,
  store: Store,
  multiplayer?: unknown
): PlayerID {
  // In singleplayer mode, if the client does not have a playerID
  // associated with it, we attach the currentPlayer as playerID.
  if (!multiplayer && (playerID === null || playerID === undefined)) {
    const state = store.getState();
    playerID = state.ctx.currentPlayer;
  }

  return playerID!;
}

/**
 * createDispatchers
 *
 * Create action dispatcher wrappers with bound playerID and credentials
 */
function createDispatchers(
  storeActionType: 'makeMove' | 'gameEvent' | 'plugin',
  innerActionNames: string[],
  store: Store,
  playerID: PlayerID | null,
  credentials: string,
  multiplayer?: unknown
) {
  const dispatchers: Record<string, (...args: any[]) => void> = {};
  for (const name of innerActionNames) {
    dispatchers[name] = (...args) => {
      const action = ActionCreators[storeActionType](
        name,
        args,
        assumedPlayerID(playerID, store, multiplayer),
        credentials
      );
      store.dispatch(action);
    };
  }
  return dispatchers;
}

// Creates a set of dispatchers to make moves.
export const createMoveDispatchers = createDispatchers.bind(null, 'makeMove');
// Creates a set of dispatchers to dispatch game flow events.
export const createEventDispatchers = createDispatchers.bind(null, 'gameEvent');
// Creates a set of dispatchers to dispatch actions to plugins.
export const createPluginDispatchers = createDispatchers.bind(null, 'plugin');

export class ClientImpl<
  G extends GameState = any,
  PluginAPIs extends Record<string, unknown> = Record<string, unknown>
> {
  private gameStateOverride?: any;
  private initialState: State<G>;
  readonly multiplayer: (opts: CodenamesTransportOpts) => CodenamesTransport;
  private reducer: Reducer;
  private _running: boolean;
  private subscriberCounter: number = 0;
  private subscribers: Record<string, (state: CodenamesClientState | null) => void>;
  private transport: CodenamesTransport;
  private manager: ClientManager;
  private readonly _deltalog$: Subject<LogEntry[]>
  readonly debugOpt?: any | boolean;
  readonly game: ReturnType<typeof ProcessGameConfig>;
  readonly store: Store<State<G>, ActionShape.Any>;
  readonly deltalog$: Observable<LogEntry[]>;
  log: State['deltalog'];
  matchID: string;
  playerID: PlayerID | null;
  credentials: string;
  matchData?: MatchData;
  moves: Record<string, (...args: any[]) => void> = {};
  events: {
    endGame?: (gameover?: any) => void;
    endPhase?: () => void;
    endTurn?: (arg?: { next: PlayerID }) => void;
    setPhase?: (newPhase: string) => void;
    endStage?: () => void;
    setStage?: (newStage: string) => void;
    setActivePlayers?: (arg: ActivePlayersArg) => void;
  } = {};
  plugins: Record<string, (...args: any[]) => void> = {};

  playerName: string | undefined;
  playerLocale: string | undefined;
  playerImage: string | null | undefined;
  roomID: string | null | undefined;
  userCount: number;
  onJoinMatch: CodenamesClientOptions['onJoinMatch'];
  servertime: number | undefined;
  setupData: any;
  gameName: string | undefined;
  syncError: any;
  roomTimeout: boolean | undefined;
  resyncPending: boolean = false;
  lastTransportReceivedAt: number = 0;
  transportSyncCheckInterval: ReturnType<typeof setInterval> | undefined;


  chatMessages: ChatMessage[];
  sendChatMessage: (message: any) => void;
  sendUpdatePlayer: (data: any) => void;
  sendRemovePlayer: (playerID?: string | null) => void;
  updateSetupData: (data: any) => void;
  playAgain: () => void;
  requestSync: () => void;
  joinMatch: (data: any) => void;
  syncCheck: () => void;
  reset: () => void;
  undo: () => void;
  redo: () => void;
  timelinePatch: (patch: any, deltas?: any[]) => void;

  constructor({
    game,
    debug,
    numPlayers,
    multiplayer,
    matchID,
    playerID,
    credentials,
    enhancer,
    onJoinMatch,
    roomID,
    playerName,
    playerImage,
    playerLocale,
  }: CodenamesClientOptions) {
    this.game = ProcessGameConfig(game);
    this.gameName = this.game.name;
    this.playerID = playerID ?? null!;
    this.matchID = matchID ?? 'default';
    this.credentials = credentials ?? generateCredentials();
    this.multiplayer = multiplayer;
    this.debugOpt = debug;
    this.manager = GlobalClientManager;
    this.gameStateOverride = null;
    this.subscribers = {};
    this._running = false;
    this.userCount = 0;
    this.onJoinMatch = onJoinMatch;
    this.roomID = roomID;
    this.playerName = playerName;
    this.playerImage = playerImage;
    this.playerLocale = playerLocale;
    this.log = [];
    this._deltalog$ = new Subject<LogEntry[]>();
    this.deltalog$ = this._deltalog$.asObservable();


    this.reducer = CreateGameReducer({
      game: this.game,
      isClient: multiplayer !== undefined,
    });

    this.initialState = null!;
    if (!multiplayer) {
      this.initialState = InitializeGame({ game: this.game, numPlayers });
    }

    // --- Bound action helpers ---

    this.reset = () => {
      this.store.dispatch(reset(this.initialState));
    };

    this.undo = () => {
      const action = undo(
        assumedPlayerID(this.playerID, this.store, this.multiplayer),
        this.credentials
      );
      this.store.dispatch(action as ActionShape.Undo);
    };

    this.redo = () => {
      const action = redo(
        assumedPlayerID(this.playerID, this.store, this.multiplayer),
        this.credentials
      );
      this.store.dispatch(action as ActionShape.Redo);
    };

    this.timelinePatch = (patchData: any, deltas: any[] = []) => {
      const stateID = this.store.getState()._stateID;
      const action = patch(stateID, stateID, patchData, deltas);
      this.store.dispatch(action);
    };

    // --- Middleware ---

    const subscriptionMiddleware: Middleware = () => (next) => (action) => {
      const result = next(action);
      this.notifySubscribers();
      return result;
    };

    /**
     * Middleware that intercepts actions and sends them to the master,
     * which keeps the authoritative version of the state.
     */
    const transportMiddleware: Middleware = (store) => (next) => (action) => {
      const beforeState = store.getState();
      const result = next(action);
      if (!('clientOnly' in action) && action.type !== Actions.RESET) {
        this.transport.sendAction(beforeState, action);
      }
      return result;
    };

    /**
    * Middleware that manages the log object.
    * Reducers generate deltalogs, which are log events
    * that are the result of application of a single action.
    * The master may also send back a deltalog or the entire
    * log depending on the type of request.
    * The middleware below takes care of all these cases while
    * managing the log object.
    */
    const logMiddleware: Middleware =
      (store) => (next) => (action) => {
        const result = next(action);
        const state = store.getState();

        switch (action.type) {
          case Actions.MAKE_MOVE:
          case Actions.GAME_EVENT:
          case Actions.UNDO:
          case Actions.REDO: {
            const deltalog = state.deltalog as LogEntry[];
            this.log = [...this.log!, ...deltalog!];
            this.emitDeltalog(deltalog)
            break;
          }

          case Actions.RESET: {
            this.log = [];
            break;
          }
          case Actions.PATCH:
          case Actions.UPDATE: {
            let id = -1;
            if (this.log!.length > 0) {
              id = this.log![this.log!.length - 1]._stateID;
            }

            let deltalog = (action.deltalog || []) as LogEntry[];

            // Filter out actions that are already present
            // in the current log. This may occur when the
            // client adds an entry to the log followed by
            // the update from the master here.
            deltalog = deltalog.filter((l) => l._stateID > id);

            this.log = [...this.log!, ...deltalog];
            this.emitDeltalog(deltalog)
            break;
          }

          case Actions.SYNC: {
            this.initialState = action.initialState;
            this.log = action.log || [];
            break;
          }
        }

        return result;
      };


    const middlewareEnhancer = applyMiddleware(
      subscriptionMiddleware,
      transportMiddleware,
      logMiddleware,
    );

    const storeEnhancer =
      enhancer !== undefined
        ? compose(middlewareEnhancer, enhancer)
        : middlewareEnhancer;

    this.store = createStore(this.reducer as any, this.initialState as any, storeEnhancer);

    // --- Transport ---

    this.transport = multiplayer({
      transportDataCallback: (data: any) => this.receiveTransportData(data),
      gameKey: game,
      game: this.game,
      matchID: this.matchID,
      playerID: this.playerID!,
      credentials: this.credentials,
      gameName: this.game.name,
      numPlayers,
      roomID: this.roomID ?? undefined,
      playerName: this.playerName ?? '',
      playerImage: this.playerImage,
      playerLocale: this.playerLocale,
    });

    this.createDispatchers();

    // --- Chat & player management ---

    this.chatMessages = [];

    this.sendChatMessage = (payload: any) => {
      this.transport.sendChatMessage(this.matchID, {
        id: nanoid(7),
        sender: this.playerID,
        payload,
      });
    };

    this.sendUpdatePlayer = (data: any) => {
      if (!data.playerID) data.playerID = this.playerID;
      this.transport.sendUpdatePlayer(this.matchID, data);
    };

    this.sendRemovePlayer = (playerID: string | null = null) => {
      this.transport.sendRemovePlayer(this.matchID, playerID ?? this.playerID!);
    };

    this.updateSetupData = (data: any) => {
      this.transport.updateSetupData(this.matchID, data);
    };

    this.playAgain = () => {
      this.transport.playAgain(this.matchID);
    };

    this.requestSync = () => {
      this.transport.requestSync();
    };

    this.joinMatch = (data: any) => {
      this.transport.joinMatch(data);
    };

    this.syncCheck = () => {
      const state = this.store.getState();
      if (state == null) return;
      this.transport.syncCheck({
        matchID: this.matchID,
        stateID: state._stateID,
        logLength: this.log!.length,
      });
    };
  }

  receiveMatchData(matchData: any, userCount?: number): void {
    this.matchData = matchData;
    if (userCount !== undefined) {
      this.userCount = userCount;
    }
    this.notifySubscribers();
  }

  receiveChatMessage(message: any): void {
    this.chatMessages = [...this.chatMessages, message];
    this.notifySubscribers();
  }

  receiveTransportData(data: any): void {
    this.lastTransportReceivedAt = Date.now();

    switch (data.type) {
      case 'sync': {
        const [matchID, syncState] = data.args;
        if (matchID !== this.matchID) return;

        this.resyncPending = false;
        this.syncError = undefined;
        this.roomTimeout = undefined;
        this.servertime = syncState.servertime;
        this.setupData = syncState.setupData;
        this.gameName = syncState.gameName;

        const action = sync(syncState);
        this.receiveMatchData(syncState.filteredMetadata, 0);
        this.store.dispatch(action);
        break;
      }

      case 'update': {
        const [matchID, newState, deltalog, servertime] = data.args;
        if (matchID !== this.matchID) return;

        this.servertime = servertime;

        const currentState = this.store.getState();
        if (newState._stateID >= currentState._stateID) {
          const action = update(newState, deltalog);
          this.store.dispatch(action);
        }
        break;
      }

      case 'patch': {
        const [matchID, prevStateID, nextStateID, patchData, deltas, servertime] =
          data.args;
        if (matchID !== this.matchID) return;

        this.servertime = servertime;

        const currentState = this.store.getState();
        const currentStateID = currentState ? currentState._stateID : -1;
        if (prevStateID !== currentStateID) {
          if (nextStateID > currentStateID && !this.resyncPending) {
            this.resyncPending = true;
            this.transport.requestSync();
          }
          break;
        }

        // Sanitize remove operations where the target property does not exist in state
        // (e.g. server-side transients like /plugins/log/data/metadata).
        // rfc6902 strict compliance produces a MissingError if deleting a non-existent path.
        const sanitizedPatch = Array.isArray(patchData)
          ? patchData.filter((op: any) => {
              if (op && op.op === 'remove' && typeof op.path === 'string') {
                const parts = op.path.split('/').filter(Boolean);
                let curr: any = currentState;
                for (const part of parts) {
                  if (curr == null || typeof curr !== 'object' || !(part in curr)) {
                    return false;
                  }
                  curr = curr[part];
                }
              }
              return true;
            })
          : patchData;

        const action = patch(prevStateID, nextStateID, sanitizedPatch, deltas);
        this.store.dispatch(action);

        // If patch failed to advance the state, request a full sync
        if (this.store.getState()._stateID === currentStateID) {
          this.transport.requestSync();
        }
        break;
      }

      case 'matchData': {
        const [matchID, matchData, userCount] = data.args;
        if (matchID !== this.matchID) return;
        this.receiveMatchData(matchData, userCount);
        break;
      }

      case 'playNextMatch': {
        const [matchID, nextMatchID] = data.args;
        if (matchID !== this.matchID) return;
        this.updateMatchID(nextMatchID);
        break;
      }

      case 'createdMatch': {
        const [roomID, matchID, playerID, credentials] = data.args;
        if ('default' !== this.matchID && this.matchID !== matchID) return;
        this.syncError = undefined;
        this.roomTimeout = undefined;
        this.updateCreatedMatch(roomID, matchID, playerID, credentials);
        break;
      }

      case 'joinedMatch': {
        const [matchID, playerID, credentials] = data.args;
        if ('default' !== this.matchID && this.matchID !== matchID) return;
        this.syncError = undefined;
        this.roomTimeout = undefined;
        this.updateMatchID(matchID);
        this.updatePlayerID(playerID);
        this.updateCredentials(credentials);
        this.onJoinMatch?.({ playerID, credentials });
        break;
      }

      case 'chat': {
        const [matchID, message] = data.args;
        if (matchID !== this.matchID) return;
        this.receiveChatMessage(message);
        break;
      }

      case 'setupData': {
        const [matchID, payload] = data.args;
        if (matchID !== this.matchID) return;

        if (payload?.setupData !== undefined) {
          this.setupData = payload.setupData;
        }

        const gameNameChanged =
          payload?.gameName !== undefined &&
          payload.gameName !== this.gameName;

        if (payload?.gameName !== undefined) {
          this.gameName = payload.gameName;
        }

        this.notifySubscribers();

        if (gameNameChanged) {
          this.transport.requestSync();
        }
        break;
      }

      case 'sync-error': {
        const [matchID, error] = data.args;
        if (matchID !== this.matchID) return;
        this.syncError = error;
        this.notifySubscribers();
        break;
      }

      case 'roomTimeout': {
        const [matchID] = data.args;
        if (matchID !== this.matchID) return;
        this.roomTimeout = true;
        this.notifySubscribers();
        break;
      }
    }
  }

  notifySubscribers(): void {
    Object.values(this.subscribers).forEach((cb) => cb(this.getState()));
  }

  private emitDeltalog(deltalog: LogEntry[]) {
    if (deltalog) {
      this._deltalog$.next(deltalog)
    }
  }

  overrideGameState(state: any): void {
    this.gameStateOverride = state;
    this.notifySubscribers();
  }

  start(): void {
    if (this._running) return;
    this.transport.connect();
    this._running = true;
    this.manager.register(this as any);
    this.transportSyncCheckInterval = setInterval(() => {
      if (Date.now() - this.lastTransportReceivedAt > 8000) {
        this.syncCheck();
      }
    }, 5000);
  }

  get running(): boolean {
    return this._running;
  }

  stop(): void {
    this.transport.disconnect();
    this._running = false;
    this.manager.unregister(this as any);
    clearInterval(this.transportSyncCheckInterval);
  }

  subscribe(callback: (state: CodenamesClientState | null) => void): () => void {
    const id = String(++this.subscriberCounter);
    this.subscribers[id] = callback;

    this.transport.subscribeToConnectionStatus(() =>
      this.notifySubscribers()
    );

    if (this._running || !this.multiplayer) {
      callback(this.getState());
    }

    return () => {
      delete this.subscribers[id];
    };
  }

  getInitialState() {
    return this.initialState;
  }

  getState(): CodenamesClientState {
    let state = this.store.getState();

    if (this.gameStateOverride !== null) {
      state = this.gameStateOverride;
    }

    if (state === null) return state;

    let isActive = true;
    const isPlayerActive = this.game.flow.isPlayerActive(
      state.G,
      state.ctx,
      this.playerID!
    );

    if (!isPlayerActive) {
      isActive = false;
    }

    if (
      !this.multiplayer &&
      this.playerID !== null &&
      this.playerID !== undefined &&
      !isPlayerActive
    ) {
      isActive = false;
    }

    if (state.ctx.gameover !== undefined) {
      isActive = false;
    }

    if (!this.multiplayer) {
      state = {
        ...state,
        G: this.game.playerView!({
          G: state.G,
          ctx: state.ctx,
          playerID: this.playerID,
        }),
        plugins: PlayerView(state, { game: this.game, playerID: this.playerID! }),
      };
    }

    return {
      ...state,
      log: this.log ?? [],
      isActive,
      isConnected: this.transport.isConnected,
      servertime: this.servertime,
      setupData: this.setupData,
      gameName: this.gameName as GameName,
      syncError: this.syncError,
      roomTimeout: this.roomTimeout,
      roomID: this.roomID,
      matchID: this.matchID,
    };
  }

  createDispatchers(): void {
    this.moves = createMoveDispatchers(
      this.game.moveNames,
      this.store,
      this.playerID,
      this.credentials,
      this.multiplayer
    );
    this.events = createEventDispatchers(
      this.game.flow.enabledEventNames,
      this.store,
      this.playerID,
      this.credentials,
      this.multiplayer
    );
    this.plugins = createPluginDispatchers(
      this.game.pluginNames,
      this.store,
      this.playerID,
      this.credentials,
      this.multiplayer
    );
  }

  updatePlayerID(playerID: string): void {
    this.playerID = playerID;
    this.createDispatchers();
    this.transport.updatePlayerID(playerID);
    this.notifySubscribers();
  }

  updateMatchID(matchID: string): void {
    this.matchID = matchID;
    this.createDispatchers();
    this.transport.updateMatchID(matchID);
    this.notifySubscribers();
  }

  updateCredentials(credentials: string): void {
    this.credentials = credentials;
    this.createDispatchers();
    this.transport.updateCredentials(credentials);
    this.notifySubscribers();
  }

  updateCreatedMatch(
    roomID: string,
    matchID: string,
    playerID: string,
    credentials: string
  ): void {
    this.roomID = roomID;
    this.matchID = matchID;
    this.playerID = playerID;
    this.credentials = credentials;
    this.createDispatchers();
    this.transport.updateMatchInfo(
      roomID,
      matchID,
      playerID,
      credentials,
      this.gameName!
    );
    this.notifySubscribers();
  }
}