import { createTicketsApp } from '../server/tickets-service/app';
import { TicketRepository } from '../server/tickets-service/repository';
import { seedTickets } from '../server/tickets-service/seed';
import { TicketsClient } from '../server/clients/tickets-client';
import { openDatabase } from '../server/lib/sqlite';

export const TOKEN = 'test-token';

/**
 * Sobe o serviço de chamados em memória e devolve um cliente que fala com ele pelo
 * contrato HTTP real (app.fetch), sem abrir porta.
 */
export function makeTicketsStack(opts: { failureRate?: number; random?: () => number; now?: Date } = {}) {
  const repo = new TicketRepository(openDatabase(':memory:'), () => opts.now ?? new Date());
  seedTickets(repo, opts.now ?? new Date());
  const app = createTicketsApp(repo, { token: TOKEN, failureRate: opts.failureRate ?? 0, random: opts.random });
  const client = new TicketsClient({
    baseUrl: 'http://tickets.test',
    token: TOKEN,
    fetch: (input, init) => app.fetch(new Request(input as string, init)),
    sleep: async () => {},
  });
  return { repo, app, client };
}
