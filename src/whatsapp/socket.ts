import { EventEmitter } from 'events';
import { WASocket, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, ConnectionState, proto } from '@whiskeysockets/baileys';
import { createAuthState, clearAuthState } from './auth-state';
import { createMessageHandler } from './message-handler';
import { CompiledAccountConfig } from '../config/types';
import { logger as baseLogger } from '../utils/logger';
const logger = baseLogger.child({ name: 'whatsapp-socket' });

export class WhatsAppSocket extends EventEmitter {
  private socket: WASocket | null = null;
  private accountConfig: CompiledAccountConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;
  private isConnecting = false;
  private qrRequested = false;
  private latestQR: string | null = null;
  private groupNames = new Map<string, string>();

  constructor(accountConfig: CompiledAccountConfig) {
    super();
    this.accountConfig = accountConfig;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.socket) return;
    this.isConnecting = true;

    try {
      const { state, saveCreds } = await createAuthState(this.accountConfig.sessionName);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: logger.child({ account: this.accountConfig.name }),
        printQRInTerminal: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
        qrTimeout: 40000,
        connectTimeoutMs: 40000,
      });

      this.setupEventHandlers(saveCreds);
      
      this.reconnectAttempts = 0;
    } catch (error) {
      this.isConnecting = false;
      this.emit('error', error as Error);
      this.scheduleReconnect();
    }
  }

  private setupEventHandlers(saveCreds: () => Promise<void>): void {
    if (!this.socket) return;

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.latestQR = qr;
        if (this.qrRequested) {
          this.emit('qr', qr);
          this.qrRequested = false;
        }
      }

      if (connection === 'open') {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        logger.info({ account: this.accountConfig.name }, 'Connected');
        this.emit('connected');
        // Cache group names in background (no hot-path latency)
        this.cacheGroupNames().catch(e => logger.warn({ account: this.accountConfig.name, error: e }, 'Failed to cache group names'));
      } else if (connection === 'close') {
        this.isConnecting = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const reason = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 
                       statusCode === DisconnectReason.connectionLost ? 'connection_lost' : 
                       statusCode === DisconnectReason.connectionReplaced ? 'replaced' : 'unknown';
        
        logger.warn({ account: this.accountConfig.name, reason, statusCode }, 'Disconnected');
        this.emit('disconnected', reason);

        if (reason !== 'logged_out' && reason !== 'replaced') {
          this.scheduleReconnect();
        } else {
          this.cleanup();
        }
      } else if (connection === 'connecting') {
        logger.info({ account: this.accountConfig.name }, 'Connecting...');
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type === 'notify' || type === 'append') {
        for (const msg of messages) {
          this.handleMessage(msg);
        }
      }
    });
  }

  private handleMessage(msg: proto.IWebMessageInfo): void {
    if (!this.socket) return;
    
    const handler = createMessageHandler(
      this.accountConfig,
      this.socket,
      (match) => this.emit('message-match', match)
    );
    handler(msg);
  }

  requestQR(): void {
    this.qrRequested = true;
    // Si ya tenemos un QR reciente, enviarlo de inmediato
    if (this.latestQR) {
      this.emit('qr', this.latestQR);
      this.qrRequested = false;
      return;
    }
    // Si no hay QR, forzar cierre y limpieza (incluyendo QR cache)
    this.latestQR = null;
    if (this.socket) {
      try { this.socket.ws.close(); } catch {}
      this.cleanup();
    }
    // El caller (manager) se encargará de borrar sesión y llamar connect()
  }

  getQR(): string | null {
    return this.latestQR;
  }

  clearQR(): void {
    this.latestQR = null;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch (e) {
        logger.warn({ account: this.accountConfig.name, error: e }, 'logout failed, forcing cleanup');
      }
      try { this.socket.ws.close(); } catch {}
      this.cleanup();
    }
    // Siempre borrar sesión aunque logout falle
    try {
      await clearAuthState(this.accountConfig.sessionName);
      this.latestQR = null;
      this.groupNames.clear();
    } catch (e) {
      logger.error({ account: this.accountConfig.name, error: e }, 'Failed to clear auth state');
    }
    this.emit('disconnected', 'user_requested');
  }

  getStatus(): { connected: boolean; user?: string } {
    return {
      connected: this.socket?.user !== undefined,
      user: this.socket?.user?.id,
    };
  }

  getGroupName(jid: string): string {
    return this.groupNames.get(jid) ?? jid;
  }

  private async cacheGroupNames(): Promise<void> {
    if (!this.socket) return;
    const groups = Array.from(this.accountConfig.authorizedGroups);
    for (const jid of groups) {
      try {
        const meta = await this.socket.groupMetadata(jid);
        if (meta.subject) this.groupNames.set(jid, meta.subject);
      } catch (e) {
        logger.debug({ account: this.accountConfig.name, jid, error: e }, 'Failed to fetch group name');
      }
    }
    if (this.groupNames.size > 0) {
      logger.info({ account: this.accountConfig.name, count: this.groupNames.size }, 'Cached group names');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({ account: this.accountConfig.name }, 'Max reconnect attempts reached');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    logger.info({ account: this.accountConfig.name, attempt: this.reconnectAttempts, delay }, 'Scheduling reconnect');
    
    setTimeout(() => {
      this.connect().catch(e => this.emit('error', e));
    }, delay);
  }

  private cleanup(): void {
    this.socket = null;
    this.isConnecting = false;
  }
}