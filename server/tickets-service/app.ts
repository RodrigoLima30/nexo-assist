import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { CATEGORIES, IMPACTS, PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from '@shared/domain';
import { TicketError, type TicketRepository } from './repository';

/**
 * API do serviço de chamados "legado". É um processo separado do agent, com banco
 * próprio, autenticado por um token de serviço. Toda leitura e escrita exige o e-mail
 * do solicitante: o serviço nunca devolve um chamado para quem não o abriu.
 */
export interface TicketsAppOptions {
  token: string;
  /** Probabilidade de responder 503 (instabilidade simulada do sistema legado). */
  failureRate: number;
  random?: () => number;
}

const email = z.string().email().transform((s) => s.toLowerCase());

const createSchema = z.object({
  type: z.enum(TICKET_TYPES),
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(4000),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  affected: z.enum(IMPACTS),
  requesterEmail: email,
  author: z.string().min(1),
});

const commentSchema = z.object({ requesterEmail: email, text: z.string().min(1).max(4000), author: z.string().min(1) });
const transferSchema = z.object({
  requesterEmail: email,
  team: z.string().min(1),
  summary: z.string().min(1).max(4000),
  author: z.string().min(1),
});
const statusSchema = z.object({
  requesterEmail: email,
  status: z.enum(TICKET_STATUSES),
  note: z.string().min(1).max(1000),
  author: z.string().min(1),
});

function fail(c: Context, err: unknown) {
  if (err instanceof TicketError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: 'Dados inválidos', code: 'invalid', issues: err.issues }, 400);
  }
  throw err;
}

export function createTicketsApp(repo: TicketRepository, opts: TicketsAppOptions): Hono {
  const app = new Hono();
  const random = opts.random ?? Math.random;

  app.get('/health', (c) => c.json({ ok: true }));

  const guard: MiddlewareHandler = async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${opts.token}`) {
      return c.json({ error: 'Não autorizado', code: 'unauthorized' }, 401);
    }
    if (random() < opts.failureRate) {
      return c.json({ error: 'Sistema de chamados temporariamente indisponível', code: 'unavailable' }, 503);
    }
    await next();
  };
  app.use('/tickets', guard);
  app.use('/tickets/*', guard);

  app.get('/tickets', (c) => {
    try {
      const requester = email.parse(c.req.query('requester'));
      const scope = c.req.query('scope') === 'all' ? 'all' : 'open';
      return c.json({ tickets: repo.listByRequester(requester, scope) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/tickets/:id', (c) => {
    try {
      const requester = email.parse(c.req.query('requester'));
      return c.json({ ticket: repo.getForRequester(c.req.param('id'), requester) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/tickets', async (c) => {
    try {
      const body = createSchema.parse(await c.req.json());
      const { author, ...input } = body;
      const { ticket, replayed } = repo.create(input, author, c.req.header('idempotency-key') ?? null);
      return c.json({ ticket, replayed }, replayed ? 200 : 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/tickets/:id/comments', async (c) => {
    try {
      const body = commentSchema.parse(await c.req.json());
      const ticket = repo.addComment(c.req.param('id'), body.requesterEmail, body.text, body.author, c.req.header('idempotency-key') ?? null);
      return c.json({ ticket });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/tickets/:id/reopen', async (c) => {
    try {
      const body = commentSchema.parse(await c.req.json());
      const ticket = repo.reopen(c.req.param('id'), body.requesterEmail, body.text, body.author, c.req.header('idempotency-key') ?? null);
      return c.json({ ticket });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/tickets/:id/transfer', async (c) => {
    try {
      const body = transferSchema.parse(await c.req.json());
      const ticket = repo.transfer(c.req.param('id'), body.requesterEmail, body.team, body.summary, body.author);
      return c.json({ ticket });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/tickets/:id/status', async (c) => {
    try {
      const body = statusSchema.parse(await c.req.json());
      const ticket = repo.setStatus(c.req.param('id'), body.requesterEmail, body.status, body.author, body.note);
      return c.json({ ticket });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
