import { EventEmitter } from 'events';
import { WhatsAppSocket } from './socket';
import { CompiledAccountConfig } from '../config/types';
import { MessageMatch } from './message-handler';

export class WhatsAppManager extends EventEmitter {
  private sockets: Map<'work' | 'personal', WhatsAppSocket> = new Map();
  private accountConfigs: Map<'work' | 'personal', CompiledAccountConfig> = new Map();

  constructor(accountConfigs: CompiledAccountConfig[]) {
    super();
    for (const config of accountConfigs) {
      this.accountConfigs.set(config.name, config);
    }
  }

  async connect(account: 'work' | 'personal'): Promise<void> {
    const config = this.accountConfigs.get(account);
    if (!config) throw new Error(`Unknown account: ${account}`);

    if (this.sockets.has(account)) {
      const existing = this.sockets.get(account)!;
      if (existing.getStatus().connected) return;
    }

    const socket = new WhatsAppSocket(config);
    this.setupSocketEvents(account, socket);
    this.sockets.set(account, socket);
    await socket.connect();
  }

  async connectAll(): Promise<void> {
    await Promise.all([
      this.connect('work'),
      this.connect('personal'),
    ]);
  }

  private setupSocketEvents(account: 'work' | 'personal', socket: WhatsAppSocket): void {
    socket.on('qr', (qr: string) => this.emit('qr', account, qr));
    socket.on('connected', () => this.emit('connected', account));
    socket.on('disconnected', (reason: string) => this.emit('disconnected', account, reason));
    socket.on('message-match', (match: MessageMatch) => this.emit('message-match', match));
    socket.on('error', (error: Error) => this.emit('error', account, error));
  }

  async disconnect(account: 'work' | 'personal' | 'both'): Promise<void> {
    const accounts = account === 'both' ? ['work', 'personal'] as const : [account];
    for (const acc of accounts) {
      const socket = this.sockets.get(acc);
      if (socket) {
        await socket.disconnect();
        this.sockets.delete(acc);
      }
    }
  }

  async requestQR(account: 'work' | 'personal'): Promise<{ ok: boolean; reason?: string }> {
    const status = this.getStatus(account);
    if (status.connected) {
      return { ok: false, reason: 'already_connected' };
    }
    if (status.hasSession) {
      return { ok: false, reason: 'has_session' };
    }
    let socket = this.sockets.get(account);
    if (!socket) {
      const config = this.accountConfigs.get(account);
      if (!config) return { ok: false, reason: 'unknown_account' };
      socket = new WhatsAppSocket(config);
      this.setupSocketEvents(account, socket);
      this.sockets.set(account, socket);
    }
    // Intentar usar QR cacheado primero
    socket.requestQR();
    // Si no había QR cacheado, requestQR limpió el socket; reconectar
    if (!socket.getQR()) {
      await socket.connect();
    }
    return { ok: true };
  }

  getStatus(account: 'work' | 'personal'): { connected: boolean; user?: string; hasSession: boolean } {
    const socket = this.sockets.get(account);
    const config = this.accountConfigs.get(account);
    const { sessionExists } = require('./session-store');
    
    return {
      connected: socket?.getStatus().connected ?? false,
      user: socket?.getStatus().user,
      hasSession: config ? sessionExists(config.sessionName) : false,
    };
  }

  getAllStatus(): Record<'work' | 'personal', ReturnType<WhatsAppManager['getStatus']>> {
    return {
      work: this.getStatus('work'),
      personal: this.getStatus('personal'),
    };
  }

  getSocket(account: 'work' | 'personal'): WhatsAppSocket | undefined {
    return this.sockets.get(account);
  }
}