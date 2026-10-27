import type { Category, Impact, TicketType } from '@shared/domain';
import type { Draft, SelectorPurpose } from '@shared/chat';

/**
 * Memória de trabalho de uma conversa com o agent. Fica persistida junto da conversa,
 * então o funcionário pode voltar outro dia e continuar de onde parou.
 */
export type Pending =
  | { kind: 'ask_impact' }
  | { kind: 'ask_urgency' }
  | { kind: 'ask_details' }
  | { kind: 'article'; articleId: string }
  | { kind: 'select_ticket'; purpose: SelectorPurpose; ticketIds: string[] }
  | { kind: 'offer_human'; ticketId: string | null }
  | { kind: 'await_info'; ticketId: string }
  | { kind: 'confirm_draft'; draftId: string }
  | { kind: 'clarify' };

/** O que já sabemos sobre o problema/pedido que pode virar um chamado. */
export interface IssueSlots {
  /** Tudo o que o funcionário disse sobre o problema, em ordem. */
  utterances: string[];
  title: string | null;
  description: string | null;
  type: TicketType | null;
  category: Category | null;
  impact: Impact | null;
  blocked: boolean | null;
  deadlineToday: boolean | null;
  deadlineText: string | null;
  hasWorkaround: boolean | null;
  articleChecked: boolean;
  duplicateChecked: boolean;
  /** Observações do agent que vão para a descrição (ex.: artigo não se aplica). */
  notes: string[];
}

export interface AgentState {
  pending: Pending | null;
  slots: IssueSlots | null;
  draft: Draft | null;
  focusTicketId: string | null;
  lowConfidenceStreak: number;
  draftSeq: number;
}

export function initialState(): AgentState {
  return { pending: null, slots: null, draft: null, focusTicketId: null, lowConfidenceStreak: 0, draftSeq: 0 };
}

export function emptySlots(): IssueSlots {
  return {
    utterances: [],
    title: null,
    description: null,
    type: null,
    category: null,
    impact: null,
    blocked: null,
    deadlineToday: null,
    deadlineText: null,
    hasWorkaround: null,
    articleChecked: false,
    duplicateChecked: false,
    notes: [],
  };
}
