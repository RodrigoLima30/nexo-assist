import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChatMessage, ConsoleConversationResponse, ConsoleListResponse, ConversationResponse, StreamEvent } from '@shared/chat';
import { AgentEngine } from '../server/agent/engine';
import { OfflineInterpreter } from '../server/agent/interpreter/offline';
import { ConversationService } from '../server/app/conversations';
import { createApi } from '../server/app/http';
import { Store } from '../server/app/store';
import { openDatabase } from '../server/lib/sqlite';
import { makeTicketsStack } from './helpers';

const dir = mkdtempSync(path.join(tmpdir(), 'nexo-api-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // No Windows os arquivos do SQLite seguem abertos até o processo terminar; o SO limpa o tmp.
  }
});

function boot(dbFile = path.join(dir, `app-${Math.random().toString(36).slice(2)}.db`), opts: { maxUserMessages?: number } = {}) {
  const { client } = makeTicketsStack();
  const store = new Store(openDatabase(dbFile));
  const engine = new AgentEngine({ tickets: client, interpreter: new OfflineInterpreter() });
  const service = new ConversationService(store, engine, client, { maxUserMessages: opts.maxUserMessages ?? 30, streamDelayMs: 0 });
  const app = createApi(store, service, { secureCookies: false, chatRateLimitPerMinute: 100, llmEnabled: false, model: 'offline' });
  return { app, dbFile, client };
}

type App = ReturnType<typeof boot>['app'];

async function login(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'qualquer' }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly');
  return cookie.split(';')[0]!;
}

async function get<T>(app: App, cookie: string, url: string): Promise<{ status: number; body: T }> {
  const res = await app.request(url, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(app: App, cookie: string, url: string, body: unknown = {}): Promise<{ status: number; body: T }> {
  const res = await app.request(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** Envia uma mensagem e devolve os eventos do stream SSE. */
async function send(app: App, cookie: string, conversationId: string, text: string, action?: unknown): Promise<StreamEvent[]> {
  const res = await app.request('/api/chat/messages', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, text, action }),
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const raw = await res.text();
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as StreamEvent);
}

describe('API', () => {
  it('login aceita funcionário do diretório e recusa e-mail desconhecido', async () => {
    const { app } = boot();
    const bad = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@y.com', password: '1' }) });
    expect(bad.status).toBe(401);
    const cookie = await login(app, 'ana.souza@nexo.com.br');
    const me = await get<{ user: { name: string } }>(app, cookie, '/api/auth/me');
    expect(me.body.user.name).toBe('Ana Souza');
  });

  it('separa perfis: funcionário não acessa o console e analista não usa o chat', async () => {
    const { app } = boot();
    const ana = await login(app, 'ana.souza@nexo.com.br');
    const rafael = await login(app, 'rafael.lima@nexo.com.br');
    expect((await get(app, ana, '/api/console/conversations')).status).toBe(403);
    expect((await get(app, rafael, '/api/chat/conversation')).status).toBe(403);
    expect((await get(app, '', '/api/chat/conversation')).status).toBe(401);
  });

  it('transmite passos e texto em tempo real e persiste a conversa', async () => {
    const { app } = boot();
    const ana = await login(app, 'ana.souza@nexo.com.br');
    const { body } = await get<ConversationResponse>(app, ana, '/api/chat/conversation');
    const events = await send(app, ana, body.conversation.id, 'Qual o status do meu chamado?');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('user_message');
    expect(types).toContain('step');
    expect(types).toContain('delta');
    expect(types.at(-1)).toBe('done');
    const agent = events.find((e): e is Extract<StreamEvent, { type: 'agent_message' }> => e.type === 'agent_message')!;
    expect(agent.message.trace?.action.code).toBe('select_ticket');

    const again = await get<ConversationResponse>(app, ana, '/api/chat/conversation');
    expect(again.body.messages.map((m) => m.author)).toEqual(['user', 'agent']);
    expect(again.body.conversation.userMessageCount).toBe(1);
  });

  it('não deixa um funcionário ler a conversa de outro', async () => {
    const { app } = boot();
    const ana = await login(app, 'ana.souza@nexo.com.br');
    const carla = await login(app, 'carla.mendes@nexo.com.br');
    const { body } = await get<ConversationResponse>(app, ana, '/api/chat/conversation');
    expect((await get(app, carla, `/api/chat/conversation/${body.conversation.id}`)).status).toBe(404);
    const res = await app.request('/api/chat/messages', {
      method: 'POST',
      headers: { cookie: carla, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: body.conversation.id, text: 'oi' }),
    });
    expect(res.status).toBe(404);
  });

  it('transferência pausa o agent; analista assume, responde, devolve e encerra', async () => {
    const { app } = boot();
    const ana = await login(app, 'ana.souza@nexo.com.br');
    const rafael = await login(app, 'rafael.lima@nexo.com.br');
    const conv = (await get<ConversationResponse>(app, ana, '/api/chat/conversation')).body.conversation;

    const handoff = await send(app, ana, conv.id, 'Quero falar com um analista');
    const last = handoff.filter((e) => e.type === 'conversation').at(-1) as Extract<StreamEvent, { type: 'conversation' }>;
    expect(last.conversation.mode).toBe('waiting_analyst');

    // Agent em pausa: a mensagem é guardada, mas não há resposta do agent.
    const paused = await send(app, ana, conv.id, 'Alguém aí?');
    expect(paused.some((e) => e.type === 'paused')).toBe(true);
    expect(paused.some((e) => e.type === 'agent_message')).toBe(false);

    const list = await get<ConsoleListResponse>(app, rafael, '/api/console/conversations?filter=needs_you');
    const item = list.body.items.find((i) => i.id === conv.id)!;
    expect(item.handoff?.kind).toBe('user_request');
    expect(item.unread).toBe(1);

    const detail = await get<ConsoleConversationResponse>(app, rafael, `/api/console/conversations/${conv.id}`);
    expect(detail.body.tickets.length).toBeGreaterThan(0);
    expect(detail.body.tickets.every((t) => t.id !== 'REQ-10447')).toBe(true);

    expect((await post(app, rafael, `/api/console/conversations/${conv.id}/messages`, { text: 'Oi!' })).status).toBe(409);
    expect((await post(app, rafael, `/api/console/conversations/${conv.id}/assume`)).status).toBe(200);
    expect((await post<{ message: ChatMessage }>(app, rafael, `/api/console/conversations/${conv.id}/messages`, { text: 'Oi, Ana! Aqui é o Rafael.' })).body.message.authorTag).toBe('Suporte N2');

    const juliana = await login(app, 'juliana.costa@nexo.com.br');
    expect((await post(app, juliana, `/api/console/conversations/${conv.id}/assume`)).status).toBe(409);

    const seen = await get<ConversationResponse>(app, ana, `/api/chat/conversation/${conv.id}`);
    expect(seen.body.conversation.mode).toBe('analyst');
    expect(seen.body.messages.some((m) => m.author === 'analyst')).toBe(true);

    await post(app, rafael, `/api/console/conversations/${conv.id}/release`);
    const back = await send(app, ana, conv.id, 'Oi');
    expect(back.some((e) => e.type === 'agent_message')).toBe(true);

    await post(app, rafael, `/api/console/conversations/${conv.id}/close`);
    const closed = await app.request('/api/chat/messages', {
      method: 'POST',
      headers: { cookie: ana, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conv.id, text: 'oi' }),
    });
    const closedEvents = (await closed.text()).includes('encerrado');
    expect(closedEvents).toBe(true);
  });

  it('conversas e estado sobrevivem a um reinício', async () => {
    const first = boot();
    const ana = await login(first.app, 'ana.souza@nexo.com.br');
    const conv = (await get<ConversationResponse>(first.app, ana, '/api/chat/conversation')).body.conversation;
    await send(first.app, ana, conv.id, 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.');

    const second = boot(first.dbFile); // mesmo arquivo de banco = reinício
    const again = await get<ConversationResponse>(second.app, ana, '/api/chat/conversation');
    expect(again.body.conversation.id).toBe(conv.id);
    expect(again.body.messages).toHaveLength(2);
    // O agent lembra que estava perguntando o impacto.
    const events = await send(second.app, ana, conv.id, 'Só eu', { type: 'answer', field: 'impact', value: 'self' });
    const agent = events.find((e): e is Extract<StreamEvent, { type: 'agent_message' }> => e.type === 'agent_message')!;
    expect(['ask_urgency', 'draft_create']).toContain(agent.message.trace?.action.code);
  });

  it('aplica o limite de mensagens por sessão', async () => {
    const { app } = boot(undefined, { maxUserMessages: 2 });
    const ana = await login(app, 'ana.souza@nexo.com.br');
    const conv = (await get<ConversationResponse>(app, ana, '/api/chat/conversation')).body.conversation;
    await send(app, ana, conv.id, 'Oi');
    await send(app, ana, conv.id, 'Oi');
    const third = await send(app, ana, conv.id, 'Oi');
    expect(third.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('limite') });
    const fresh = await post<ConversationResponse>(app, ana, '/api/chat/conversation/new');
    expect(fresh.body.conversation.id).not.toBe(conv.id);
  });
});
