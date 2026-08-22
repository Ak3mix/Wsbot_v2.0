import * as fs from 'fs';
import * as path from 'path';

const SESSION_BASE = '/tmp/whatsapp-sessions';

export function getSessionFolder(sessionName: string): string {
  return path.join(SESSION_BASE, sessionName);
}

export function deleteSession(sessionName: string): boolean {
  const folder = getSessionFolder(sessionName);
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }
  // Fallback: old single file
  const oldFile = path.join(SESSION_BASE, `${sessionName}.json`);
  if (fs.existsSync(oldFile)) {
    fs.unlinkSync(oldFile);
    return true;
  }
  return false;
}

export function sessionExists(sessionName: string): boolean {
  const folder = getSessionFolder(sessionName);
  if (fs.existsSync(path.join(folder, 'creds.json'))) return true;
  // Fallback old file
  if (fs.existsSync(path.join(SESSION_BASE, `${sessionName}.json`))) return true;
  return false;
}

export function listSessions(): string[] {
  if (!fs.existsSync(SESSION_BASE)) return [];
  return fs.readdirSync(SESSION_BASE).filter(f => {
    const p = path.join(SESSION_BASE, f);
    return fs.statSync(p).isDirectory() || f.endsWith('.json');
  }).map(f => f.replace('.json', ''));
}
