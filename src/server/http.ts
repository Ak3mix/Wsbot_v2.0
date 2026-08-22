import express, { Request, Response } from 'express';
import { WhatsAppManager } from '../whatsapp/manager';
import pino from 'pino';

const logger = pino({ name: 'http-server' });
const startTime = Date.now();

export function createHttpServer(manager: WhatsAppManager, port: number): express.Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    const status = manager.getAllStatus();
    res.json({
      status: 'ok',
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      accounts: status,
    });
  });

  app.get('/qr/:account', (req: Request, res: Response): void => {
    const account = req.params.account as 'work' | 'personal';
    if (!['work', 'personal'].includes(account)) {
      res.status(400).json({ error: 'Invalid account' });
      return;
    }

    manager.requestQR(account);
    
    setTimeout(() => {
      const socket = manager.getSocket(account);
      if (!socket) {
        res.status(503).json({ error: 'Socket not initialized' });
        return;
      }
      
      res.json({ message: 'QR requested, check Telegram' });
    }, 1000);
  });

  app.get('/status', (_req: Request, res: Response) => {
    res.json(manager.getAllStatus());
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(port, () => {
    logger.info({ port }, 'HTTP server started');
  });

  return app;
}