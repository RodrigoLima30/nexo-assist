import type { Person, Ticket } from '@shared/domain';
import { PRIORITY_LABEL, STATUS_LABEL, IMPACT_LABEL } from '@shared/domain';
import type { HandoffKind } from '@shared/chat';
import { INTENT_LABEL, type Intent } from '@shared/chat';
import { formatRelative, slaStatus } from '@shared/sla';
import type { AgentState } from './state';

export const HANDOFF_REASON: Record<HandoffKind, string> = {
  user_request: 'O funcionário pediu para falar com um analista.',
  critical: 'Caso crítico: algo parado para uma equipe ou para a empresa.',
  overdue: 'Chamado com prazo vencido.',
  low_confidence: 'O agent não teve segurança para decidir o que fazer.',
};

/** Casos graves vão direto para o N2; os demais para o N1. */
export function teamFor(kind: HandoffKind): 'Suporte N1' | 'Suporte N2' {
  return kind === 'critical' || kind === 'overdue' ? 'Suporte N2' : 'Suporte N1';
}

/**
 * Resumo do caso para o analista — o objetivo é que ele não precise perguntar tudo de novo.
 */
export function buildHandoffSummary(args: {
  kind: HandoffKind;
  user: Person;
  state: AgentState;
  ticket: Ticket | null;
  history: { author: string; text: string }[];
  lastIntent: Intent | null;
  confidence: number | null;
  now: Date;
}): string {
  const { user, state, ticket, history, now } = args;
  const lines: string[] = [];
  lines.push(`Motivo: ${HANDOFF_REASON[args.kind]}`);
  lines.push(`Funcionário: ${user.name} · ${user.department}${user.device ? ` · ${user.device} (${user.os ?? 's/ SO'})` : ''}`);
  if (ticket) {
    const sla = slaStatus(ticket, now);
    lines.push(
      `Chamado: ${ticket.id} — ${ticket.title} · ${ticket.category} · prioridade ${PRIORITY_LABEL[ticket.priority].toLowerCase()} · ${STATUS_LABEL[ticket.status]} · última atualização ${formatRelative(ticket.updatedAt, now)}${sla.overdue ? ' · PRAZO VENCIDO' : ''}`,
    );
  }
  const s = state.slots;
  if (s && s.utterances.length > 0) {
    const facts = [
      s.category ? `categoria ${s.category}` : null,
      s.impact ? `afetados: ${IMPACT_LABEL[s.impact].toLowerCase()}` : null,
      s.deadlineText ? `compromisso: ${s.deadlineText}` : s.deadlineToday ? 'há compromisso hoje' : null,
      s.blocked ? 'impedido de trabalhar' : null,
    ].filter(Boolean);
    lines.push(`Relato: ${s.description ?? s.utterances.join(' ')}${facts.length ? ` (${facts.join('; ')})` : ''}`);
  }
  const said = history.filter((h) => h.author === 'user').slice(-3).map((h) => `“${h.text}”`);
  if (said.length) lines.push(`Últimas mensagens: ${said.join(' · ')}`);
  if (args.lastIntent) {
    lines.push(
      `Leitura do agent: ${INTENT_LABEL[args.lastIntent]}${args.confidence !== null ? ` (confiança ${Math.round(args.confidence * 100)}%)` : ''}`,
    );
  }
  return lines.join('\n');
}
