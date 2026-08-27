import { EventEmitter } from 'events';
import { WASocket, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, ConnectionState, proto, jidNormalizedUser } from '@whiskeysockets/baileys';
import { createAuthState, clearAuthState } from './auth-state';
import { createMessageHandler } from './message-handler';
import { CompiledAccountConfig } from '../config/types';
import { logger as baseLogger } from '../utils/logger';
import { isShuttingDown } from '../utils/shutdown';
const logger = baseLogger.child({ name: 'whatsapp-socket' });

export class WhatsAppSocket extends EventEmitter {
  private socket: WASocket | null = null;
  private accountConfig: CompiledAccountConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;
  private isConnecting = false;
  private isConnected = false; // flag explícito vs inferirlo de socket.user
  private qrRequested = false;
  private latestQR: string | null = null;
  private groupNames = new Map<string, string>();
  private suppressNextConnected = false;
  private suppressLogoutNotification = false;
  private suppressNextDisconnect = false; // para socket.close() no-emita 'disconnected'
  private warmupDone = false;
  private warmupInProgress = false;
  private messageHandler: ((msg: proto.IWebMessageInfo) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(accountConfig: CompiledAccountConfig) {
    super();
    this.accountConfig = accountConfig;
  }

  async connect(): Promise<void> {
    // Si ya está conectado o conectando, nada que hacer
    if (this.isConnected || this.isConnecting) return;
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
        // No marcar presencia 'available': permite que el teléfono físico siga
        // sonando/notificando aunque el bot esté conectado
        markOnlineOnConnect: false,
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
        this.isConnected = true;
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
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const errMsg = (lastDisconnect?.error as any)?.message ?? '';
        const is515 = statusCode === 515 || errMsg.includes('515') || errMsg.includes('Stream Errored');
        const reason = statusCode === DisconnectReason.loggedOut ? 'logged_out' :
                       statusCode === DisconnectReason.connectionLost ? 'connection_lost' :
                       statusCode === DisconnectReason.connectionReplaced ? 'replaced' :
                       is515 ? 'stream_515' : 'unknown';

        // Siempre limpiar el socket viejo antes de decidir qué hacer
        this.cleanup();

        // 515 es restart normal post-pairing: no notificar como desconexión, reconectar silencioso
        if (is515) {
          this.latestQR = null;
          this.suppressNextConnected = true;
          logger.info({ account: this.accountConfig.name }, '515 restart required — silent reconnect');
          this.connect().catch(e => this.emit('error', e));
          return;
        }

        // Shutdown intencional (deploy/SIGTERM): la desconexión es esperada.
        // Sin notificación a Telegram ni reconnect — el proceso va a morir.
        if (isShuttingDown()) {
          logger.info({ account: this.accountConfig.name, reason }, '🛑 Shutdown en curso — desconexión esperada por deploy, sin notificación');
          return;
        }

        // close espurio de socket.close() → suprimir notificación duplicada
        if (this.suppressNextDisconnect) {
          this.suppressNextDisconnect = false;
          logger.info({ account: this.accountConfig.name }, 'Intentional socket close — notificación duplicada suprimida');
        } else {
          // Logout intencional: el close de Baileys (logged_out) ya lo notificaremos
          // nosotros como 'user_requested' — suprimir el duplicado
          if (this.suppressLogoutNotification) {
            this.suppressLogoutNotification = false;
            logger.info({ account: this.accountConfig.name }, 'Intentional logout — notificación duplicada suprimida');
          } else {
            logger.warn({ account: this.accountConfig.name, reason, statusCode, errMsg }, 'Disconnected');
            this.emit('disconnected', reason);
          }
        }

        if (reason !== 'logged_out' && reason !== 'replaced') {
          this.scheduleReconnect();
        }
      } else if (connection === 'connecting') {
        logger.info({ account: this.accountConfig.name }, 'Connecting...');
      }
    });

    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type === 'notify') {
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
      this.suppressNextDisconnect = true;
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
    // NO anular messageHandler: el bot sigue conectado y debe seguir recibiendo
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
    this.isConnected = false;
    this.emit('disconnected', 'user_requested');
  }

  getStatus(): { connected: boolean; user?: string } {
    return {
      connected: this.isConnected,
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
   *
   * Usa groupFetchAllParticipating: UNA query para todos los grupos (la versión
   * anterior con groupMetadata por grupo moría con 408 en cada uno y tardaba horas).
   */
  private async prepareGroupsBackground(): Promise<void> {
    // Capturar la referencia del socket ANTES de cualquier await, y bloquear concurrencia
    if (this.warmupInProgress || this.warmupDone || !this.socket) return;
    this.warmupInProgress = true;
    const mySocket = this.socket;

    try {
      // El socket emite 'open' antes de estar listo para servir queries:
      // las queries justo después mueren con 408 Timed Out. Darle aire.
      await new Promise(r => setTimeout(r, 5000));
      // Si durante la espera la conexión se cayó y reconectó, este warmup quedó
      // huérfano: abortar sin marcar warmupDone para que la nueva conexión haga el suyo.
      if (this.socket !== mySocket) return;

      const warmupEnabled = !['off', 'false', '0'].includes((process.env.WARMUP_SESSIONS ?? 'on').toLowerCase());
      const authorized = this.accountConfig.authorizedGroups;

      try {
        // 1 sola llamada: metadatos de TODOS los grupos participantes
        const all = await mySocket.groupFetchAllParticipating();
        if (this.socket !== mySocket) return;

        let warmed = 0;
        for (const [jid, meta] of Object.entries(all)) {
          // Solo grupos autorizados de esta cuenta
          const cleanJid = jid.replace(/@g\.us$/, '');
          if (!authorized.has(jid) && !authorized.has(cleanJid)) continue;

          if (meta.subject) this.groupNames.set(jid, meta.subject);

          if (warmupEnabled && meta.participants?.length) {
            try {
              const t0 = Date.now();
              const participants = meta.participants.map(p => jidNormalizedUser(p.id));
              // force=false: solo descarga PreKeys de quienes aún no tienen sesión
              await (mySocket as any).assertSessions(participants, false);
              warmed++;
              logger.info({
                account: this.accountConfig.name,
                groupJid: jid,
                miembros: participants.length,
                ms: Date.now() - t0,
              }, `🔥 grupo precalentado "${meta.subject}"`);
            } catch (e) {
              logger.warn({ account: this.accountConfig.name, jid, error: e }, 'Falló assertSessions para grupo');
            }
            // Pacing anti-rate-limit entre grupos
            await new Promise(r => setTimeout(r, 1500));
            if (this.socket !== mySocket) return;
          }
        }

        this.warmupDone = true;
        logger.info(
          { account: this.accountConfig.name, autorizados: authorized.size, precalentados: warmed },
          '✅ Warmup de grupos completado'
        );
      } catch (e) {
        logger.warn(
          { account: this.accountConfig.name, error: e },
          '⚠️ Warmup falló (groupFetchAllParticipating) — se reintentará en la próxima reconexión'
        );
        this.scheduleWarmupRetry();
      }
    } finally {
      this.warmupInProgress = false;
    }
  }

  /** Reintento único del warmup a los 60s si la query inicial falló. */
  private scheduleWarmupRetry(): void {
    setTimeout(() => {
      if (this.socket && !this.warmupDone && !this.warmupInProgress) {
        logger.info({ account: this.accountConfig.name }, 'Reintentando warmup');
        this.prepareGroupsBackground().catch(() => {});
      }
    }, 60_000);
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

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(e => this.emit('error', e));
    }, delay);
  }

  private cleanup(): void {
    // Cancelar timer de reconexión si existe (zombies)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket = null;
    this.isConnecting = false;
    this.isConnected = false;
    // warmupDone se resetea: tras un reconnect (515/restart) debemos re-precalentar
    this.warmupDone = false;
  }
}
