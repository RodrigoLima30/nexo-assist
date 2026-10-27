import type { Category, Impact, Person, Priority, TicketStatus, TicketType } from './domain';

// ---------------------------------------------------------------------------
// Ações estruturadas: cliques em opções rápidas, seleção de chamado e rascunho.
// Elas chegam ao agent já interpretadas — não gastam chamada de LLM.
// ---------------------------------------------------------------------------

export type ClientAction =
  | { type: 'answer'; field: 'impact'; value: Impact }
  | { type: 'answer'; field: 'urgency'; value: 'blocked' | 'deadline' | 'workaround' | 'none' }
  | { type: 'select_ticket'; ticketId: string; purpose: SelectorPurpose }
  | { type: 'request_human' }
  | { type: 'add_info'; ticketId: string }
  | { type: 'decline' }
  | { type: 'article_resolved' }
  | { type: 'article_not_resolved' }
  /** Abrir um chamado novo mesmo havendo um parecido (o funcionário diz que é outro problema). */
  | { type: 'open_new' }
  | { type: 'confirm_draft'; draftId: string; edits?: DraftEdits }
  | { type: 'cancel_draft'; draftId: string }
  | { type: 'start'; topic: 'problem' | 'status' | 'question' };

export type SelectorPurpose = 'status' | 'add_info';

export interface QuickOption {
  label: string;
  action: ClientAction;
}

// ---------------------------------------------------------------------------
// Blocos ricos que acompanham uma mensagem do agent
// ---------------------------------------------------------------------------

export interface TicketSummary {
  id: string;
  title: string;
  status: TicketStatus;
  category: Category;
  priority: Priority;
  updatedAt: string;
  createdAt: string;
  overdue: boolean;
}

export interface TicketView extends TicketSummary {
  type: TicketType;
  description: string;
  affected: Impact;
  dueAt: string | null;
  slaLabel: string;
  resolvedAt: string | null;
  lastEvent: { text: string; at: string } | null;
}

export type DraftMode = 'create' | 'update' | 'reopen';

export interface Draft {
  id: string;
  mode: DraftMode;
  /** Chamado existente, para atualização ou reabertura. */
  ticketId: string | null;
  type: TicketType;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  affected: Impact;
  /** Texto adicionado ao chamado (atualização/reabertura). */
  comment: string | null;
  priorityReason: string;
  dueAt: string;
  slaLabel: string;
}

export type DraftEdits = Partial<Pick<Draft, 'title' | 'description' | 'category' | 'priority' | 'affected' | 'comment'>>;

export type DraftState = 'pending' | 'confirmed' | 'cancelled' | 'superseded';

export type Block =
  | { kind: 'options'; question: string | null; options: QuickOption[] }
  | { kind: 'ticket_selector'; purpose: SelectorPurpose; tickets: TicketSummary[] }
  | { kind: 'ticket_card'; ticket: TicketView }
  | { kind: 'draft'; draft: Draft; state: DraftState; resultTicketId: string | null }
  | { kind: 'article'; articleId: string; title: string }
  | { kind: 'handoff'; team: string; reason: string };

// ---------------------------------------------------------------------------
// Trilha de decisão — o "porquê" de cada resposta (transparência)
// ---------------------------------------------------------------------------

export type Intent =
  | 'greeting'
  | 'faq'
  | 'report_issue'
  | 'request'
  | 'ticket_status'
  | 'add_info'
  | 'talk_to_human'
  | 'out_of_scope'
  | 'answer_pending'
  | 'thanks'
  | 'unclear';

export const INTENT_LABEL: Record<Intent, string> = {
  greeting: 'Saudação',
  faq: 'Dúvida (central de ajuda)',
  report_issue: 'Relato de problema (incidente)',
  request: 'Pedido de acesso, equipamento ou software (requisição)',
  ticket_status: 'Consulta de chamado',
  add_info: 'Complementar um chamado',
  talk_to_human: 'Pedido para falar com um analista',
  out_of_scope: 'Assunto fora de TI',
  answer_pending: 'Resposta a uma pergunta do agent',
  thanks: 'Agradecimento / encerramento',
  unclear: 'Não ficou claro',
};

export type TraceStepStatus = 'ok' | 'error' | 'skipped';

export interface TraceStep {
  id: string;
  /** Rótulo curto exibido acima da resposta: "consultou seus chamados". */
  label: string;
  tool: string;
  status: TraceStepStatus;
  detail: string | null;
  durationMs: number;
  /**
   * Passos de contexto (carregar chamados, buscar artigos, interpretar) aparecem sempre
   * no detalhe, mas só vão para a linha de status quando a decisão realmente os usou.
   */
  visible: boolean;
  input?: unknown;
  output?: unknown;
}

export interface DecisionTrace {
  /** Quem interpretou a mensagem: o LLM, o interpretador offline ou um clique (ação estruturada). */
  interpreter: 'llm' | 'offline' | 'action' | 'fallback';
  model: string | null;
  intent: Intent;
  /** O que o agent entendeu, em uma frase. */
  understood: string;
  /** Fatos extraídos (categoria, impacto, chamado citado...). */
  facts: Record<string, string>;
  /** Ação escolhida. */
  action: { code: string; label: string };
  /** Grau de segurança de 0 a 1. */
  confidence: number;
  /** Por que essa ação. */
  reasoning: string;
  /** Regras do service desk aplicadas. */
  rules: string[];
  steps: TraceStep[];
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

// ---------------------------------------------------------------------------
// Conversas e mensagens
// ---------------------------------------------------------------------------

export type Author = 'user' | 'agent' | 'analyst' | 'system';

export interface ChatMessage {
  id: string;
  conversationId: string;
  author: Author;
  authorName: string | null;
  /** Equipe do analista, exibida como etiqueta ("Suporte N2"). */
  authorTag: string | null;
  text: string;
  blocks: Block[];
  trace: DecisionTrace | null;
  createdAt: string;
}

/**
 * Estado da conversa: com o agent, aguardando atendente (agent pausado),
 * com um analista (agent pausado) ou encerrada.
 */
export type ConversationMode = 'agent' | 'waiting_analyst' | 'analyst' | 'closed';

export type HandoffKind = 'user_request' | 'critical' | 'overdue' | 'low_confidence';

export interface Handoff {
  kind: HandoffKind;
  reason: string;
  team: 'Suporte N1' | 'Suporte N2';
  summary: string;
  confidence: number | null;
  ticketId: string | null;
  at: string;
}

export interface ConversationView {
  id: string;
  userEmail: string;
  mode: ConversationMode;
  assignedAnalyst: { email: string; name: string } | null;
  handoff: Handoff | null;
  userMessageCount: number;
  maxUserMessages: number;
  resolvedBy: 'agent' | 'analyst' | null;
  focusTicketId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Contratos HTTP
// ---------------------------------------------------------------------------

export interface MeResponse {
  user: Person;
}

export interface ConversationResponse {
  conversation: ConversationView;
  messages: ChatMessage[];
}

export interface SendMessageRequest {
  conversationId: string;
  text: string;
  action?: ClientAction;
}

/** Eventos do stream SSE de uma resposta. */
export type StreamEvent =
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'step'; step: TraceStep }
  | { type: 'delta'; text: string }
  | { type: 'agent_message'; message: ChatMessage }
  | { type: 'conversation'; conversation: ConversationView }
  | { type: 'paused'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type ConsoleFilter = 'all' | 'needs_you' | 'with_agent' | 'mine' | 'closed';

export interface ConsoleListItem {
  id: string;
  employee: { email: string; name: string; department: string };
  mode: ConversationMode;
  assignedAnalyst: { email: string; name: string } | null;
  handoff: Handoff | null;
  resolvedBy: 'agent' | 'analyst' | null;
  lastMessage: { author: Author; text: string; at: string } | null;
  unread: number;
  ticketId: string | null;
  updatedAt: string;
}

export interface ConsoleListResponse {
  items: ConsoleListItem[];
  counts: Record<ConsoleFilter, number>;
}

export interface ConsoleConversationResponse {
  conversation: ConversationView;
  employee: Person;
  messages: ChatMessage[];
  tickets: TicketView[];
  /** Preenchido quando o serviço de chamados não respondeu. */
  ticketsError: string | null;
}

export interface ApiError {
  error: string;
  code?: string;
}
