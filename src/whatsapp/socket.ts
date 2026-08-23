import { EventEmitter } from 'events';
import { WASocket, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, ConnectionState, proto, jidNormalizedUser } from '@whiskeysockets/baileys';
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
  private suppressNextConnected = false;
  private suppressLogoutNotification = false;
  private warmupDone = false;
  private messageHandler: ((msg: proto.IWebMessageInfo) => void) | null = null;

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
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
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

    // Create message handler ONCE per connection
    this.messageHandler = createMessageHandler(
      this.accountConfig,
      this.socket,
      (match) => this.emit('message-match', match),
      (jid) => this.getGroupName(jid)
    );

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
        if (this.suppressNextConnected) {
          this.suppressNextConnected = false;
          logger.info({ account: this.accountConfig.name }, 'Suppressing connected notification after 515 restart');
        } else {
          this.emit('connected');
        }
        // Cache group names + pre-warm E2E sessions in background (no hot-path latency)
        this.prepareGroupsBackground().catch(e => logger.warn({ account: this.accountConfig.name, error: e }, 'Error en warmup de grupos'));
      } else if (connection === 'close') {
        this.isConnecting = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const errMsg = (lastDisconnect?.error as any)?.message ?? '';
        const is515 = statusCode === 515 || errMsg.includes('515') || errMsg.includes('Stream Errored');
        const reason = statusCode === DisconnectReason.loggedOut ? 'logged_out' : 
                       statusCode === DisconnectReason.connectionLost ? 'connection_lost' : 
                       statusCode === DisconnectReason.connectionReplaced ? 'replaced' :
                       is515 ? 'stream_515' : 'unknown';
        
        // 515 es restart normal post-pairing: no notificar como desconexión, reconectar silencioso
        if (is515) {
          this.latestQR = null;
          this.suppressNextConnected = true;
          this.cleanup();
          logger.info({ account: this.accountConfig.name }, '515 restart required — silent reconnect');
          this.connect().catch(e => this.emit('error', e));
          return;
        }

        // Logout intencional: el close de Baileys (logged_out) ya lo notificaremos
        // nosotros como 'user_requested' — suprimir el duplicado
        if (this.suppressLogoutNotification) {
          this.suppressLogoutNotification = false;
          logger.info({ account: this.accountConfig.name }, 'Intentional logout — notificación duplicada suprimida');
        } else {
          logger.warn({ account: this.accountConfig.name, reason, statusCode, errMsg }, 'Disconnected');
          this.emit('disconnected', reason);
        }

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
          this.messageHandler?.(msg);
        }
      }
    });
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
    this.messageHandler = null;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.suppressLogoutNotification = true;
      try {
        await this.socket.logout();
      } catch (e) {
        // logout falló sin disparar el close de Baileys: restaurar flag para
        // no silenciar una desconexión real futura
        this.suppressLogoutNotification = false;
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

  /**
   * Al abrir conexión: cachea nombres de grupos y pre-construye las sesiones E2E
   * (PreKey Bundles) con los miembros de cada grupo autorizado en background.
   * Así el primer sendMessage del grupo no paga los roundtrips de PreKeys (~30s).
   */
  private async prepareGroupsBackground(): Promise<void> {
    if (!this.socket) return;
    if (this.warmupDone) {
      logger.debug({ account: this.accountConfig.name }, 'Warmup ya ejecutado, omitiendo');
      return;
    }
    this.warmupDone = true;

    const warmupEnabled = !['off', 'false', '0'].includes((process.env.WARMUP_SESSIONS ?? 'on').toLowerCase());
    const groups = Array.from(this.accountConfig.authorizedGroups);

    for (const jid of groups) {
      try {
        // 1 sola llamada a groupMetadata: nombre + participantes
        const meta = await this.socket.groupMetadata(jid);
        if (meta.subject) this.groupNames.set(jid, meta.subject);

        // Warmup: asertar sesiones Signal con todos los miembros (force=false:
        // solo descarga PreKeys de quienes no tienen sesión aún)
        if (warmupEnabled && meta.participants?.length) {
          const t0 = Date.now();
          const participants = meta.participants.map(p => jidNormalizedUser(p.id));
          await (this.socket as any).assertSessions(participants, false);
          logger.info({
            account: this.accountConfig.name,
            groupJid: jid,
            miembros: participants.length,
            ms: Date.now() - t0,
          }, `🔥 grupo precalentado "${meta.subject}"`);
        } else if (!warmupEnabled) {
          logger.debug({ account: this.accountConfig.name, jid }, 'Warmup deshabilitado (WARMUP_SESSIONS=off)');
        }
      } catch (e) {
        logger.warn({ account: this.accountConfig.name, jid, error: e }, 'Falló warmup/nombre para grupo');
      }

      // Pacing anti-rate-limit entre grupos
      await new Promise(r => setTimeout(r, 1500));
    }

    logger.info({ account: this.accountConfig.name, total: groups.length }, '✅ Warmup de grupos completado');
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