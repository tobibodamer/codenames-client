/**
 * transport/CodenamesSocketIO.ts
 *
 * Custom boardgame.io transport ported from the codenames.game production
 * bundle. Extends the standard SocketIO transport with extra socket events
 * and emit methods specific to the codenames.game server fork.
 *
 * Key differences from the standard boardgame.io SocketIO transport:
 *  - requestSync() sends an extended payload with playerName, playerLocale, etc.
 *  - Handles extra server events: createdMatch, joinedMatch, playNextMatch,
 *    room-timeout, wrongNamespace, updateServerURL, setupData, sync-error
 *  - Adds extra emit methods: joinMatch, playAgain, updateSetupData,
 *    sendUpdatePlayer, sendRemovePlayer
 *  - Implements shard switching: the server can redirect to a different URL
 *    via updateServerURL / wrongNamespace events
 */

import { TransportOpts } from 'boardgame.io/dist/types/src/client/transport/transport';
import { Transport } from 'boardgame.io/internal';
import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';


// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TransportData {
  type: string;
  args: unknown[];
}

export interface CodenamesTransportOpts extends TransportOpts {
  roomID?: string | null;
  playerName?: string | null;
  playerImage?: string | null;
  playerLocale?: string | null;
  server?: string | null;
  socketOpts?: Partial<ManagerOptions & SocketOptions>;
  getServerURLAndPath?: GetServerURLAndPath;
}

export type GetServerURLAndPath = (url: URL) => { serverURL: string; path: string };

// ─── The default getServerURLAndPath from codenames.game ───────────────────────

export function codenamesGetServerURLAndPath(url: URL): { serverURL: string; path: string } {
  const serverURL = `${url.protocol}//${url.host}`;
  const trailingSlash = url.pathname[url.pathname.length - 1] === '/' ? '' : '/';
  return {
    serverURL,
    path: `${url.pathname}${trailingSlash}socket.io`,
  };
}

// ─── Transport class ───────────────────────────────────────────────────────────

export class CodenamesTransport extends Transport {
  // Extra fields beyond the base transport
  declare socket: Socket | null;
  private socketOpts: Partial<ManagerOptions & SocketOptions>;
  private server: string;
  /** Snapshot of original lobby server — used by resetToLobby() */
  private lobbyServer: string;
  private lobbySocketOpts: Partial<ManagerOptions & SocketOptions>;
  private getServerURLAndPath: GetServerURLAndPath;

  // Extra player metadata sent in requestSync
  private roomID: string;
  private playerName: string;
  private playerImage: string | null | undefined;
  private playerLocale: string;

  constructor(opts: CodenamesTransportOpts) {
    super(opts);
    this.server = opts.server ?? '';
    this.lobbyServer = opts.server ?? '';
    this.socketOpts = opts.socketOpts ? { ...opts.socketOpts } : {};
    this.lobbySocketOpts = opts.socketOpts ? { ...opts.socketOpts } : {};
    this.getServerURLAndPath = opts.getServerURLAndPath ?? codenamesGetServerURLAndPath;
    this.roomID = opts.roomID ?? '';
    this.playerName = opts.playerName ?? '';
    this.playerImage = opts.playerImage;
    this.playerLocale = opts.playerLocale ?? 'en';
    this.socket = null;
  }

  // ── Outbound emit methods ─────────────────────────────────────────────────

  /** Send a game move to the server */
  override sendAction(state: { _stateID: number }, action: unknown): void {
    this.socket?.emit('update', action, state._stateID, this.matchID, this.playerID);
  }

  sendChatMessage(matchID: string, message: unknown): void {
    this.socket?.emit('chat', matchID, message, this.credentials);
  }

  sendUpdatePlayer(matchID: string, data: unknown): void {
    this.socket?.emit('updatePlayer', matchID, this.playerID, this.credentials, data);
  }

  sendRemovePlayer(matchID: string, targetPlayerID: string): void {
    this.socket?.emit('removePlayer', matchID, this.playerID, this.credentials, targetPlayerID);
  }

  updateSetupData(matchID: string, data: unknown): void {
    this.socket?.emit('updateSetupData', matchID, this.playerID, this.credentials, data);
  }

  playAgain(matchID: string): void {
    this.socket?.emit('playAgain', matchID, this.playerID, this.credentials);
  }

  joinMatch(joinPayload: unknown): void {
    this.socket?.emit('joinMatch', this.matchID, joinPayload);
  }

  syncCheck(data: unknown): void {
    this.socket?.emit('sync-check', data);
  }

  // ── Connection management ─────────────────────────────────────────────────

  override connect(): void {
    if (!this.socket) {
      let url: string;
      if (this.server) {
        url = this.server.endsWith('/') ? this.server : this.server + '/';
        url += this.gameName;
      } else {
        url = '/' + this.gameName;
      }
      this.socket = io(url, this.socketOpts)
    }

    // ── Inbound event handlers ──────────────────────────────────────────────

    this.socket.on('patch', (matchID, prevID, nextID, patches, log, servertime) => {
      this.notifyClient({ type: 'patch', args: [matchID, prevID, nextID, patches, log, servertime] } as any);
    });

    this.socket.on('update', (matchID, state, deltalog, action) => {
      this.notifyClient({ type: 'update', args: [matchID, state, deltalog, action] } as any);
    });

    this.socket.on('sync', (matchID, data) => {
      this.updateServerURL(data?.serverURL);
      this.notifyClient({ type: 'sync', args: [matchID, data] });
    });

    this.socket.on('sync-error', (err: { matchID: string; error: string }) => {
      this.notifyClient({ type: 'sync-error', args: [err.matchID, err.error] } as any);
    });

    this.socket.on('room-timeout', (data: { matchID: string }) => {
      this.notifyClient({ type: 'roomTimeout', args: [data.matchID] } as any);
    });

    this.socket.on('updateServerURL', (url: string) => {
      this.updateServerURL(url);
    });

    this.socket.on('matchData', (matchID, players, userCount) => {
      this.notifyClient({ type: 'matchData', args: [matchID, players, userCount] } as any);
    });

    this.socket.on('updatePlayerError', (err: { error: string }) => {
      console.error('updatePlayer failed:', err.error);
    });

    this.socket.on('playNextMatch', (matchID: string, nextMatchID: string) => {
      this.notifyClient({ type: 'playNextMatch', args: [matchID, nextMatchID] } as any);
    });

    this.socket.on('joinedMatch', (matchID: string, playerID: string, credentials: string) => {
      this.notifyClient({ type: 'joinedMatch', args: [matchID, playerID, credentials] } as any);
    });

    this.socket.on('createdMatch', (roomID, matchID, playerID, credentials, serverURL) => {
      this.updateServerURL(serverURL);
      this.notifyClient({ type: 'createdMatch', args: [roomID, matchID, playerID, credentials, serverURL] } as any);
    });

    this.socket.on('chat', (matchID: string, message: unknown) => {
      this.notifyClient({ type: 'chat', args: [matchID, message] } as any);
    });

    this.socket.on('setupData', (matchID: string, data: unknown) => {
      this.notifyClient({ type: 'setupData', args: [matchID, data] } as any);
    });

    // If the server tells us we're in the wrong namespace, reconnect to the right one
    this.socket.on('wrongNamespace', (correctGameName: string) => {
      this.gameName = correctGameName;
      this.disconnect();
      this.connect();
    });

    this.socket.on('connect', () => {
      this.requestSync();
      this.setConnectionStatus(true);
    });

    this.socket.on('disconnect', (e) => {
      this.setConnectionStatus(false);
    });

    // If reconnection completely fails, fall back to the lobby server
    this.socket.io?.on('reconnect_failed', () => {
      this.resetToLobby();
    });
  }

  override disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.setConnectionStatus(false);
  }

  /**
   * Send the sync handshake. Includes extra codenames.game metadata fields
   * not present in the standard boardgame.io requestSync.
   */
  override requestSync(): void {
    if (!this.socket) return;
    const meta = {
      playerName: this.playerName,
      playerImage: this.playerImage,
      playerLocale: this.playerLocale,
      roomID: this.roomID,
      credentials: this.credentials,
    };
    this.socket.emit('sync', this.matchID, this.playerID, this.credentials, meta);
  }

  // ── Server URL / shard switching ──────────────────────────────────────────

  /**
   * Called when the server sends a new URL (shard redirect).
   * Parses the URL and reconnects if anything changed.
   */
  private updateServerURL(rawURL: string | undefined): void {
    if (!rawURL) return;
    const parsed = this.getServerURLAndPath(new URL(rawURL));
    let changed = false;

    if (this.server !== parsed.serverURL) {
      this.server = parsed.serverURL;
      changed = true;
    }
    if (this.socketOpts.path !== parsed.path) {
      this.socketOpts.path = parsed.path;
      changed = true;
    }

    if (changed) {
      // Limit reconnection attempts to avoid a loop while switching shards
      this.socketOpts.reconnectionAttempts = 2;
      this.disconnect();
      this.connect();
    }
  }

  /** Fall back to the original lobby server after total reconnection failure */
  private resetToLobby(): void {
    this.disconnect();
    this.server = this.lobbyServer;
    this.socketOpts = { ...this.lobbySocketOpts };
    this.connect();
  }

  // ── Match info update (called by Client after joinedMatch / createdMatch) ──

  updateMatchInfo(
    roomID: string,
    matchID: string,
    playerID: string,
    credentials: string,
    gameName: string
  ): void {
    this.roomID = roomID;
    this.matchID = matchID;
    this.playerID = playerID;
    this.credentials = credentials;
    this.gameName = gameName;
    this.requestSync();
  }

  override updateMatchID(id: string): void {
    this.matchID = id;
    this.requestSync();
  }

  override updatePlayerID(id: string): void {
    this.playerID = id;
    this.requestSync();
  }

  override updateCredentials(creds: string): void {
    this.credentials = creds;
    this.requestSync();
  }
}

// ─── Factory (mirrors the boardgame.io SocketIO() factory signature) ──────────

export interface CodenamesSocketIOOptions {
  server: string;
  socketOpts?: Partial<ManagerOptions & SocketOptions>;
  getServerURLAndPath?: GetServerURLAndPath;
}

/**
 * Drop-in replacement for boardgame.io's SocketIO() that uses the
 * codenames-specific transport. Pass this as the `multiplayer` option to Client().
 *
 * @example
 * const client = Client({
 *   game: CNDuetGame,
 *   multiplayer: CodenamesSocketIO({
 *     server: 'https://server-discord.gke.codenames.game',
 *   }),
 *   matchID, playerID, credentials, ...
 * });
 */
export function CodenamesSocketIO(opts: CodenamesSocketIOOptions) {
  return (transportOpts: CodenamesTransportOpts): CodenamesTransport =>
    new CodenamesTransport({
      server: opts.server,
      socketOpts: opts.socketOpts ?? {},
      getServerURLAndPath: opts.getServerURLAndPath ?? codenamesGetServerURLAndPath,
      ...transportOpts,
    });
}