import { EventEmitter } from 'events';
import { WASocket, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, ConnectionState, proto } from '@whiskeysockets/baileys';
import { createAuthState, clearAuthState } from './auth-state';
import { createMessageHandler } from './message-handler';
import { CompiledAccountConfig } from '../config/types';
import pino from 'pino';

const logger = pino({ name: 'whatsapp-socket' });

export class WhatsAppSocket extends EventEmitter {
  private socket: WASocket | null = null;
  private accountConfig: CompiledAccountConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;
  private isConnecting = false;
  private qrRequested = false;

  constructor(accountConfig: CompiledAccountConfig) {
    super();
    this.accountConfig = accountConfig;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.socket) return;
    this.isConnecting = true;

    try {
      const { state, saveCreds } = createAuthState(this.accountConfig.sessionName);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: logger.child({ account: this.accountConfig.name }),
        printQRInTerminal: false,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
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
    if (this.socket) {
      this.socket.ev.emit('connection.update', { qr: undefined });
    }
  }

  getQR(): string | null {
    return null;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      await this.socket.logout();
      this.socket.ws.close();
      this.cleanup();
    }
    clearAuthState(this.accountConfig.sessionName);
    this.emit('disconnected', 'user_requested');
  }

  getStatus(): { connected: boolean; user?: string } {
    return {
      connected: this.socket?.user !== undefined,
      user: this.socket?.user?.id,
    };
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