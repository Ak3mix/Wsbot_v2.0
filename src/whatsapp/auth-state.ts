import { AuthenticationState, initAuthCreds } from '@whiskeysockets/baileys';
import { loadSession, saveSession, deleteSession } from './session-store';

export function createAuthState(sessionName: string): { state: AuthenticationState; saveCreds: () => Promise<void> } {
  const loaded = loadSession(sessionName);
  const state: AuthenticationState = loaded ?? {
    creds: initAuthCreds(),
    keys: {
      'pre-key': { get: () => null, set: () => {} },
      'session': { get: () => null, set: () => {} },
      'sender-key': { get: () => null, set: () => {} },
      'app-state-sync-key': { get: () => null, set: () => {} },
      'app-state-sync-version': { get: () => null, set: () => {} },
    } as any,
  };

  let saveTimer: NodeJS.Timeout | null = null;

  const saveCreds = async (): Promise<void> => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveSession(sessionName, state);
    }, 100);
  };

  return { state, saveCreds };
}

export function clearAuthState(sessionName: string): void {
  deleteSession(sessionName);
}