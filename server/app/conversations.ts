import type { Person, Ticket } from '@shared/domain';
import { firstName } from '@shared/domain';
import type {
  ChatMessage,
  ClientAction,
  ConsoleConversationResponse,
  ConsoleFilter,
  ConsoleListItem,
  ConsoleListResponse,
  ConversationView,
  StreamEvent,
} from '@shared/chat';
import { formatTime } from '@shared/sla';
import type { AgentEngine } from '../agent/engine';
import { AGENT_NAME } from '../agent/engine';
import { toView } from '../agent/views';
import { TicketsUnavailableError, type TicketsClient } from '../clients/tickets-client';
import { findPerson, requirePerson } from '../directory/people';
import { logger } from '../lib/log';
import type { ConversationRecord, Store } from './store';

const log = logger('conversations');

export class ConversationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export interface ConversationServiceOptions {
  maxUserMessages: number;
  /** Atraso entre pedaços do texto no streaming (ms). 0 nos testes. */
  streamDelayMs: number;
  now?: () => Date;
}

/**
 * Regras da conversa, independentes de HTTP:
 * - o agent só responde quando a conversa está no modo "agent";
 * - com um analista (aguardando ou atendendo), a mensagem é guardada e o agent fica em pausa;
 * - limite de mensagens por sessão (conversa);
 * - uma resposta por vez por conversa (evita duplo clique gerando dois turnos).
 */
export class ConversationService {
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly engine: AgentEngine,
    private readonly tickets: TicketsClient,
    private readonly opts: ConversationServiceOptions,
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  view(c: ConversationRecord): ConversationView {
    return {
      id: c.id,
      userEmail: c.userEmail,
      mode: c.mode,
      assignedAnalyst: c.assignedAnalyst,
      handoff: c.handoff,
      userMessageCount: c.userMessageCount,
      maxUserMessages: this.opts.maxUserMessages,
      resolvedBy: c.resolvedBy,
      focusTicketId: c.state.focusTicketId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  // ---- Funcionário ---------------------------------------------------------

  /** Retoma a conversa em andamento (história 6: voltar outro dia) ou abre uma nova. */
  current(user: Person): { conversation: ConversationView; messages: ChatMessage[] } {
    const conv = this.store.currentConversation(user.email) ?? this.store.latestConversation(user.email) ?? this.store.createConversation(user.email);
    return { conversation: this.view(conv), messages: this.store.listMessages(conv.id) };
  }

  startNew(user: Person): { conversation: ConversationView; messages: ChatMessage[] } {
    const cur = this.store.currentConversation(user.email);
    if (cur && (cur.mode === 'waiting_analyst' || cur.mode === 'analyst')) {
      throw new ConversationError(409, 'Sua conversa atual está com um analista. Aguarde o encerramento para começar outra.', 'with_analyst');
    }
    if (cur) this.store.updateConversation(cur.id, { mode: 'closed' });
    const conv = this.store.createConversation(user.email);
    return { conversation: this.view(conv), messages: [] };
  }

  getOwned(user: Person, id: string): { conversation: ConversationView; messages: ChatMessage[] } {
    const conv = this.store.getConversation(id);
    if (!conv || conv.userEmail !== user.email) throw new ConversationError(404, 'Conversa não encontrada.', 'not_found');
    return { conversation: this.view(conv), messages: this.store.listMessages(conv.id) };
  }

  /**
   * Processa uma mensagem do funcionário e emite os eventos do stream na ordem:
   * user_message → step* → delta* → agent_message → conversation → done.
   */
  async send(user: Person, conversationId: string, rawText: string, action: ClientAction | null, emit: (e: StreamEvent) => Promise<void>): Promise<void> {
    const conv = this.store.getConversation(conversationId);
    if (!conv || conv.userEmail !== user.email) throw new ConversationError(404, 'Conversa não encontrada.', 'not_found');
    if (conv.mode === 'closed') throw new ConversationError(409, 'Este atendimento foi encerrado. Comece uma nova conversa.', 'closed');
    if (conv.userMessageCount >= this.opts.maxUserMessages) {
      throw new ConversationError(429, `Você atingiu o limite de ${this.opts.maxUserMessages} mensagens nesta sessão. Comece uma nova conversa para continuar.`, 'message_limit');
    }
    if (this.busy.has(conv.id)) throw new ConversationError(409, 'Ainda estou respondendo a mensagem anterior.', 'busy');

    const text = rawText.trim().slice(0, 2000);
    if (!text) throw new ConversationError(400, 'Mensagem vazia.', 'empty');

    this.busy.add(conv.id);
    try {
      const history = this.store
        .listMessages(conv.id)
        .filter((m) => m.author !== 'system')
        .slice(-8)
        .map((m) => ({ author: m.author, text: m.text }));
      const userMsg = this.store.addMessage({ conversationId: conv.id, author: 'user', authorName: user.name, text });
      let current = this.store.updateConversation(conv.id, { userMessageCount: conv.userMessageCount + 1 });
      await emit({ type: 'user_message', message: userMsg });

      if (current.mode !== 'agent') {
        // Regra do Anexo A: com um analista, o agent não responde.
        await emit({ type: 'paused', reason: current.mode === 'analyst' ? 'Um analista está atendendo você.' : 'Aguardando um analista. O assistente está em pausa.' });
        await emit({ type: 'conversation', conversation: this.view(current) });
        return;
      }

      const out = await this.engine.handle(
        { conversationId: conv.id, user, state: current.state, text, action, history },
        (step) => void emit({ type: 'step', step }),
      );

      if (out.draftResolution) {
        this.store.resolveDraftBlock(conv.id, out.draftResolution.draftId, out.draftResolution.state, out.draftResolution.resultTicketId);
      }

      for (const chunk of chunkText(out.text)) {
        await emit({ type: 'delta', text: chunk });
        if (this.opts.streamDelayMs > 0) await sleep(this.opts.streamDelayMs);
      }

      const agentMsg = this.store.addMessage({ conversationId: conv.id, author: 'agent', authorName: AGENT_NAME, text: out.text, blocks: out.blocks, trace: out.trace });
      current = this.store.updateConversation(conv.id, {
        state: out.state,
        resolvedBy: out.resolved ? 'agent' : null,
        ...(out.handoff ? { mode: 'waiting_analyst' as const, handoff: out.handoff } : {}),
      });
      await emit({ type: 'agent_message', message: agentMsg });
      if (out.handoff) {
        const sys = this.store.addMessage({ conversationId: conv.id, author: 'system', text: `Transferida para ${out.handoff.team} · ${formatTime(out.handoff.at)}` });
        await emit({ type: 'agent_message', message: sys });
      }
      await emit({ type: 'conversation', conversation: this.view(current) });
    } finally {
      this.busy.delete(conv.id);
    }
  }

  // ---- Console do analista -------------------------------------------------

  list(analyst: Person, filter: ConsoleFilter, q: string): ConsoleListResponse {
    const all = this.store.listConversations().filter((c) => this.store.lastMessage(c.id) !== null);
    const matches = (c: ConversationRecord, f: ConsoleFilter): boolean => {
      switch (f) {
        case 'all':
          return true;
        case 'needs_you':
          return c.mode === 'waiting_analyst';
        case 'with_agent':
          return c.mode === 'agent' && c.resolvedBy === null;
        case 'mine':
          return c.mode === 'analyst' && c.assignedAnalyst?.email === analyst.email;
        case 'closed':
          return c.mode === 'closed' || (c.mode === 'agent' && c.resolvedBy !== null);
      }
    };
    const counts: Record<ConsoleFilter, number> = { all: 0, needs_you: 0, with_agent: 0, mine: 0, closed: 0 };
    for (const c of all) for (const f of Object.keys(counts) as ConsoleFilter[]) if (matches(c, f)) counts[f]++;

    const needle = q.trim().toLowerCase();
    const items: ConsoleListItem[] = all
      .filter((c) => matches(c, filter))
      .map((c) => this.listItem(c))
      .filter(
        (it) =>
          !needle ||
          it.employee.name.toLowerCase().includes(needle) ||
          it.employee.email.includes(needle) ||
          (it.ticketId ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => rank(a, analyst) - rank(b, analyst) || b.updatedAt.localeCompare(a.updatedAt));
    return { items, counts };
  }

  private listItem(c: ConversationRecord): ConsoleListItem {
    const p = findPerson(c.userEmail);
    const last = this.store.lastMessage(c.id);
    return {
      id: c.id,
      employee: { email: c.userEmail, name: p?.name ?? c.userEmail, department: p?.department ?? '' },
      mode: c.mode,
      assignedAnalyst: c.assignedAnalyst,
      handoff: c.handoff,
      resolvedBy: c.resolvedBy,
      lastMessage: last ? { author: last.author, text: last.text, at: last.createdAt } : null,
      unread: c.mode === 'waiting_analyst' || c.mode === 'analyst' ? this.store.unreadFromUser(c.id) : 0,
      ticketId: c.handoff?.ticketId ?? c.state.focusTicketId,
      updatedAt: c.updatedAt,
    };
  }

  async detail(id: string): Promise<ConsoleConversationResponse> {
    const conv = this.requireConv(id);
    const employee = requirePerson(conv.userEmail);
    let tickets: Ticket[] = [];
    let ticketsError: string | null = null;
    try {
      tickets = await this.tickets.listMine(conv.userEmail, 'all');
    } catch (err) {
      if (!(err instanceof TicketsUnavailableError)) throw err;
      ticketsError = 'O sistema de chamados não respondeu. Tente atualizar em instantes.';
    }
    const now = this.now();
    return {
      conversation: this.view(conv),
      employee,
      messages: this.store.listMessages(conv.id),
      tickets: tickets.map((t) => toView(t, now)),
      ticketsError,
    };
  }

  async assume(analyst: Person, id: string): Promise<ConversationView> {
    const conv = this.requireConv(id);
    if (conv.mode === 'closed') throw new ConversationError(409, 'A conversa já foi encerrada.', 'closed');
    if (conv.mode === 'analyst' && conv.assignedAnalyst?.email !== analyst.email) {
      throw new ConversationError(409, `${conv.assignedAnalyst?.name} já está atendendo esta conversa.`, 'taken');
    }
    const updated = this.store.updateConversation(id, { mode: 'analyst', assignedAnalyst: { email: analyst.email, name: analyst.name } });
    this.store.addMessage({ conversationId: id, author: 'system', text: `${analyst.name} assumiu · agent pausado · ${formatTime(this.now().toISOString())}` });
    const ticketId = conv.handoff?.ticketId ?? conv.state.focusTicketId;
    if (ticketId) {
      // Melhor esforço: o atendimento segue mesmo se o sistema legado estiver instável.
      await this.tickets.setStatus(ticketId, conv.userEmail, 'em_andamento', `Assumido por ${analyst.name}.`, analyst.name).catch((err: unknown) => {
        log.warn('não foi possível atualizar o status do chamado', { ticketId, err: String(err) });
      });
    }
    return this.view(updated);
  }

  release(analyst: Person, id: string): ConversationView {
    const conv = this.requireConv(id);
    if (conv.mode === 'closed') throw new ConversationError(409, 'A conversa já foi encerrada.', 'closed');
    this.assertNotTakenByOther(conv, analyst);
    const state = { ...conv.state, pending: null, lowConfidenceStreak: 0 };
    const updated = this.store.updateConversation(id, { mode: 'agent', assignedAnalyst: null, handoff: null, state });
    this.store.addMessage({ conversationId: id, author: 'system', text: `${analyst.name} devolveu a conversa ao agent · ${formatTime(this.now().toISOString())}` });
    return this.view(updated);
  }

  close(analyst: Person, id: string): ConversationView {
    const conv = this.requireConv(id);
    this.assertNotTakenByOther(conv, analyst);
    const updated = this.store.updateConversation(id, { mode: 'closed', resolvedBy: 'analyst' });
    this.store.addMessage({ conversationId: id, author: 'system', text: `Atendimento encerrado por ${analyst.name} · ${formatTime(this.now().toISOString())}` });
    return this.view(updated);
  }

  reply(analyst: Person, id: string, rawText: string): ChatMessage {
    const conv = this.requireConv(id);
    if (conv.mode !== 'analyst' || conv.assignedAnalyst?.email !== analyst.email) {
      throw new ConversationError(409, 'Assuma o atendimento para responder.', 'not_assigned');
    }
    const text = rawText.trim().slice(0, 4000);
    if (!text) throw new ConversationError(400, 'Mensagem vazia.', 'empty');
    const msg = this.store.addMessage({ conversationId: id, author: 'analyst', authorName: analyst.name, authorTag: analyst.team ?? null, text });
    this.store.updateConversation(id, {});
    return msg;
  }

  private requireConv(id: string): ConversationRecord {
    const conv = this.store.getConversation(id);
    if (!conv) throw new ConversationError(404, 'Conversa não encontrada.', 'not_found');
    return conv;
  }

  private assertNotTakenByOther(conv: ConversationRecord, analyst: Person): void {
    if (conv.mode === 'analyst' && conv.assignedAnalyst && conv.assignedAnalyst.email !== analyst.email) {
      throw new ConversationError(409, `${firstName(conv.assignedAnalyst.name)} está atendendo esta conversa.`, 'taken');
    }
  }
}

function rank(it: ConsoleListItem, analyst: Person): number {
  if (it.mode === 'analyst' && it.assignedAnalyst?.email === analyst.email) return 0;
  if (it.mode === 'waiting_analyst') return 1;
  if (it.mode === 'agent' && it.resolvedBy === null) return 2;
  return 3;
}

function chunkText(text: string): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 6) chunks.push(words.slice(i, i + 6).join(''));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
