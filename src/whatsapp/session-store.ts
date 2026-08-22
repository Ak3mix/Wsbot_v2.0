import * as fs from 'fs';
import * as path from 'path';
import { AuthenticationState } from '@whiskeysockets/baileys';

const SESSION_DIR = '/tmp/whatsapp-sessions';

function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function getSessionPath(sessionName: string): string {
  return path.join(SESSION_DIR, `${sessionName}.json`);
}

interface StoredState {
  creds: any;
  keys?: any;
}

function createEmptyKeyStore(): any {
  const store = {
    get: () => null,
    set: () => {},
  };
  return {
    'pre-key': store,
    'session': store,
    'sender-key': store,
    'app-state-sync-key': store,
    'app-state-sync-version': store,
  };
}

export function saveSession(sessionName: string, state: AuthenticationState): void {
  ensureSessionDir();
  const sessionPath = getSessionPath(sessionName);
  const serializable: StoredState = {
    creds: state.creds,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(serializable, null, 2));
}

export function loadSession(sessionName: string): AuthenticationState | null {
  ensureSessionDir();
  const sessionPath = getSessionPath(sessionName);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as StoredState;
    return {
      creds: data.creds,
      keys: createEmptyKeyStore(),
    } as AuthenticationState;
  } catch (e) {
    console.error(`Failed to load session ${sessionName}:`, e);
    return null;
  }
}

export function deleteSession(sessionName: string): boolean {
  const sessionPath = getSessionPath(sessionName);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
    return true;
  }
  return false;
}

export function sessionExists(sessionName: string): boolean {
  return fs.existsSync(getSessionPath(sessionName));
}

export function listSessions(): string[] {
  ensureSessionDir();
  return fs.readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}