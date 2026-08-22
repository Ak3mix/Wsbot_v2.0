import pino from 'pino';

export interface LogEntry {
  time: number;
  level: number;
  name?: string;
  msg: string;
  account?: string;
  [k: string]: any;
}

const MAX_LOGS = 500;
const ring: LogEntry[] = [];

function pushLog(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > MAX_LOGS) ring.shift();
}

function createPinoLogger(name: string) {
  const base = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { name },
  });

  // Wrap to capture into ring buffer
  const wrap = (orig: Function, level: number) => (...args: any[]) => {
    const obj = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const msg = typeof args[0] === 'string' ? args[0] : args[1] ?? '';
    pushLog({ time: Date.now(), level, name, msg: String(msg), ...obj });
    return orig(...args);
  };

  const logger: any = base;
  const levels: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
  for (const [lvl, num] of Object.entries(levels)) {
    const orig = (base as any)[lvl].bind(base);
    (logger as any)[lvl] = wrap(orig, num);
  }
  // preserve child
  const origChild = base.child.bind(base);
  logger.child = (bindings: any) => {
    const c = origChild(bindings);
    for (const lvl of Object.keys(levels)) {
      const orig = (c as any)[lvl].bind(c);
      (c as any)[lvl] = wrap(orig, (levels as any)[lvl]);
    }
    return c;
  };

  return logger as pino.Logger;
}

export const logger = createPinoLogger('app');

export function getLogs(account?: 'work' | 'personal', n = 10): LogEntry[] {
  let filtered = ring;
  if (account) filtered = filtered.filter(e => e.account === account || !e.account);
  return filtered.slice(-n);
}

export function formatLog(e: LogEntry): string {
  const lvl = e.level >= 50 ? 'ERR' : e.level >= 40 ? 'WRN' : e.level >= 30 ? 'INF' : 'DBG';
  const time = new Date(e.time).toISOString().slice(11, 19);
  const acc = e.account ? `[${e.account}]` : '';
  return `${time} ${lvl}${acc} ${e.msg}`;
}
