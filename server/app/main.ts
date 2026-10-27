import { existsSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '../config';
import { AgentEngine } from '../agent/engine';
import { createInterpreter } from '../agent/interpreter';
import { TicketsClient } from '../clients/tickets-client';
import { logger } from '../lib/log';
import { openDatabase } from '../lib/sqlite';
import { ConversationService } from './conversations';
import { createApi } from './http';
import { seedConversations } from './seed-conversations';
import { Store } from './store';

const log = logger('api');

async function waitForTickets(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${config.ticketsServiceUrl}/health`);
      if (res.ok) return true;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const db = openDatabase(config.appDbPath);
  const store = new Store(db);
  const tickets = new TicketsClient({ baseUrl: config.ticketsServiceUrl, token: config.ticketsServiceToken });
  const interpreter = createInterpreter();
  const engine = new AgentEngine({ tickets, interpreter });
  const service = new ConversationService(store, engine, tickets, { maxUserMessages: config.maxUserMessages, streamDelayMs: 18 });

  const app = createApi(store, service, {
    secureCookies: config.isProduction,
    chatRateLimitPerMinute: config.chatRateLimitPerMinute,
    llmEnabled: config.llm.enabled,
    model: config.llm.model,
  });

  // Em produção, a própria API serve o front compilado (npm run build → dist/).
  const dist = path.resolve(process.cwd(), 'dist');
  if (existsSync(dist)) {
    app.use('/*', serveStatic({ root: './dist' }));
    app.get('*', serveStatic({ path: './dist/index.html' }));
  }

  serve({ fetch: app.fetch, port: config.appPort }, (info) => {
    log.info('API no ar', { port: info.port, interpreter: interpreter.name, model: config.llm.enabled ? config.llm.model : null });
  });

  if (await waitForTickets()) {
    // Seed das conversas de exemplo usa o interpretador offline: não gasta tokens no boot.
    const { OfflineInterpreter } = await import('../agent/interpreter/offline');
    const seedEngine = new AgentEngine({ tickets, interpreter: new OfflineInterpreter() });
    const n = await seedConversations(db, seedEngine, tickets, config.maxUserMessages).catch((err: unknown) => {
      log.warn('seed de conversas falhou', { err: String(err) });
      return 0;
    });
    if (n > 0) log.info('conversas de exemplo criadas', { conversations: n });
  } else {
    log.warn('serviço de chamados não respondeu no boot; conversas de exemplo não foram criadas');
  }
}

main().catch((err: unknown) => {
  log.error('falha ao iniciar a API', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
