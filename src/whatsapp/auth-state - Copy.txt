import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { getSessionFolder, deleteSession } from './session-store';

export async function createAuthState(sessionName: string) {
  const folder = getSessionFolder(sessionName);
  return useMultiFileAuthState(folder);
}

export async function clearAuthState(sessionName: string): Promise<void> {
  deleteSession(sessionName);
}
