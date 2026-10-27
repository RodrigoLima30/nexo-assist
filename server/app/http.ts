import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Person } from '@shared/domain';
import type { ClientAction, ConsoleFilter, StreamEvent } from '@shared/chat';
import { findPerson } from '../directory/people';
import { logger } from '../lib/log';
import { ConversationError, type ConversationService } from './conversations';
import { RateLimiter } from './rate-limit';
import type { Store } from './store';

const log = logger('http');
const COOKIE = 'nexo_session';

type Env = { Variables: { user: Person; token: string } };

export interface HttpOptions {
  secureCookies: boolean;
  chatRateLimitPerMinute: number;
  llmEnabled: boolean;
  model: string;
}

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

const actionSchema: z.ZodType<ClientAction> = z.union([
  z.object({ type: z.literal('answer'), field: z.literal('impact'), value: z.enum(['self', 'team', 'company', 'unknown']) }),
  z.object({ type: z.literal('answer'), field: z.literal('urgency'), value: z.enum(['blocked', 'deadline', 'workaround', 'none']) }),
  z.object({ type: z.literal('select_ticket'), ticketId: z.string().max(20), purpose: z.enum(['status', 'add_info']) }),
  z.object({ type: z.literal('request_human') }),
  z.object({ type: z.literal('add_info'), ticketId: z.string().max(20) }),
  z.object({ type: z.literal('decline') }),
  z.object({ type: z.literal('article_resolved') }),
  z.object({ type: z.literal('article_not_resolved') }),
  z.object({ type: z.literal('open_new') }),
  z.object({
    type: z.literal('confirm_draft'),
    draftId: z.string().max(20),
    edits: z
      .object({
        title: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        category: z.enum(['Acesso', 'Rede e VPN', 'Hardware', 'Software', 'E-mail', 'Outros']).optional(),
        priority: z.enum(['critica', 'alta', 'media', 'baixa']).optional(),
        affected: z.enum(['self', 'team', 'company', 'unknown']).optional(),
        comment: z.string().max(4000).optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal('cancel_draft'), draftId: z.string().max(20) }),
  z.object({ type: z.literal('start'), topic: z.enum(['problem', 'status', 'question']) }),
]);

const sendSchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string().max(2000),
  action: actionSchema.optional(),
});

const replySchema = z.object({ text: z.string().min(1).max(4000) });
const FILTERS: ConsoleFilter[] = ['all', 'needs_you', 'with_agent', 'mine', 'closed'];

function handleError(c: Context, err: unknown) {
  if (err instanceof ConversationError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: 'Requisição inválida.', code: 'invalid' }, 400);
  log.error('erro inesperado', { err: err instanceof Error ? err.stack : String(err) });
  return c.json({ error: 'Erro interno. Tente novamente.', code: 'internal' }, 500);
}

export function createApi(store: Store, service: ConversationService, opts: HttpOptions): Hono<Env> {
  const app = new Hono<Env>();
  const loginLimiter = new RateLimiter(10, 60_000);
  const chatLimiter = new RateLimiter(opts.chatRateLimitPerMinute, 60_000);

  app.use('*', secureHeaders());
  app.use('/api/*', bodyLimit({ maxSize: 32 * 1024 }));

  app.get('/api/health', (c) => c.json({ ok: true, llm: opts.llmEnabled ? opts.model : 'offline' }));

  // ---- Autenticação --------------------------------------------------------

  app.post('/api/auth/login', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (!loginLimiter.take(ip)) return c.json({ error: 'Muitas tentativas. Aguarde um minuto.', code: 'rate_limited' }, 429);
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Informe e-mail e senha.', code: 'invalid' }, 400);
    const person = findPerson(parsed.data.email);
    // Ambiente de demonstração: qualquer senha é aceita para as contas do diretório (PRD).
    if (!person) return c.json({ error: 'E-mail não encontrado no diretório da Nexo.', code: 'unknown_user' }, 401);
    const token = store.createSession(person.email);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: opts.secureCookies, path: '/', maxAge: 14 * 86_400 });
    return c.json({ user: person });
  });

  app.post('/api/auth/logout', (c) => {
    const token = getCookie(c, COOKIE);
    if (token) store.deleteSession(token);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  const requireUser = (role?: Person['role']) =>
    async function guard(c: Context<Env>, next: () => Promise<void>) {
      const token = getCookie(c, COOKIE);
      const email = token ? store.sessionEmail(token) : null;
      const user = email ? findPerson(email) : undefined;
      if (!token || !user) return c.json({ error: 'Sessão expirada. Entre novamente.', code: 'unauthenticated' }, 401);
      if (role && user.role !== role) return c.json({ error: 'Acesso não permitido para este perfil.', code: 'forbidden' }, 403);
      c.set('user', user);
      c.set('token', token);
      await next();
    };

  app.get('/api/auth/me', requireUser(), (c) => c.json({ user: c.get('user') }));

  // ---- Chat do funcionário -------------------------------------------------

  app.use('/api/chat/*', requireUser('employee'));

  app.get('/api/chat/conversation', (c) => c.json(service.current(c.get('user'))));

  app.post('/api/chat/conversation/new', (c) => {
    try {
      return c.json(service.startNew(c.get('user')));
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/chat/conversation/:id', (c) => {
    try {
      return c.json(service.getOwned(c.get('user'), c.req.param('id')));
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/chat/messages', async (c) => {
    const user = c.get('user');
    const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Requisição inválida.', code: 'invalid' }, 400);
    if (!chatLimiter.take(user.email)) {
      return c.json({ error: 'Muitas mensagens em pouco tempo. Aguarde alguns segundos.', code: 'rate_limited' }, 429);
    }
    // Valida antes de abrir o stream, para responder com o status HTTP correto.
    try {
      service.getOwned(user, parsed.data.conversationId);
    } catch (err) {
      return handleError(c, err);
    }
    return streamSSE(c, async (stream) => {
      const emit = async (e: StreamEvent) => {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      };
      try {
        await service.send(user, parsed.data.conversationId, parsed.data.text, parsed.data.action ?? null, emit);
      } catch (err) {
        if (err instanceof ConversationError) {
          await emit({ type: 'error', message: err.message });
        } else {
          log.error('falha ao processar mensagem', { err: err instanceof Error ? err.stack : String(err) });
          await emit({ type: 'error', message: 'Tive um problema para processar sua mensagem. Pode tentar de novo?' });
        }
      }
      await emit({ type: 'done' });
    });
  });

  // ---- Console do analista -------------------------------------------------

  app.use('/api/console/*', requireUser('analyst'));

  app.get('/api/console/conversations', (c) => {
    const f = c.req.query('filter') as ConsoleFilter | undefined;
    const filter = f && FILTERS.includes(f) ? f : 'all';
    return c.json(service.list(c.get('user'), filter, c.req.query('q') ?? ''));
  });

  app.get('/api/console/conversations/:id', async (c) => {
    try {
      return c.json(await service.detail(c.req.param('id')));
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/console/conversations/:id/assume', async (c) => {
    try {
      return c.json({ conversation: await service.assume(c.get('user'), c.req.param('id')) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/console/conversations/:id/release', (c) => {
    try {
      return c.json({ conversation: service.release(c.get('user'), c.req.param('id')) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/console/conversations/:id/close', (c) => {
    try {
      return c.json({ conversation: service.close(c.get('user'), c.req.param('id')) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/console/conversations/:id/messages', async (c) => {
    try {
      const body = replySchema.parse(await c.req.json());
      return c.json({ message: service.reply(c.get('user'), c.req.param('id'), body.text) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Rota não encontrada.', code: 'not_found' }, 404) : c.text('Not found', 404)));

  return app;
}
