import { serve } from '@hono/node-server';
import { config } from '../config';
import { logger } from '../lib/log';
import { openDatabase } from '../lib/sqlite';
import { createTicketsApp } from './app';
import { TicketRepository } from './repository';
import { seedTickets } from './seed';

const log = logger('tickets-service');
const repo = new TicketRepository(openDatabase(config.ticketsDbPath));
const seeded = seedTickets(repo);
if (seeded > 0) log.info('dados de exemplo criados', { tickets: seeded });

const app = createTicketsApp(repo, { token: config.ticketsServiceToken, failureRate: config.ticketsFailureRate });

serve({ fetch: app.fetch, port: config.ticketsPort }, (info) => {
  log.info('serviço de chamados no ar', { port: info.port, failureRate: config.ticketsFailureRate });
});
