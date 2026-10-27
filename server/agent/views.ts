import type { Ticket } from '@shared/domain';
import { isOpenStatus } from '@shared/domain';
import type { TicketSummary, TicketView } from '@shared/chat';
import { slaStatus } from '@shared/sla';

export function toSummary(t: Ticket, now: Date): TicketSummary {
  const sla = slaStatus(t, now);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    category: t.category,
    priority: t.priority,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    overdue: sla.overdue,
  };
}

export function toView(t: Ticket, now: Date): TicketView {
  const sla = slaStatus(t, now);
  const last = [...t.events].reverse().find((e) => e.kind !== 'created') ?? t.events.at(-1) ?? null;
  return {
    ...toSummary(t, now),
    type: t.type,
    description: t.description,
    affected: t.affected,
    dueAt: sla.dueAt,
    slaLabel: sla.ruleLabel,
    resolvedAt: t.resolvedAt,
    lastEvent: last ? { text: last.text, at: last.at } : null,
  };
}

export function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
}

export function brief(t: Ticket, now: Date) {
  const resolvedDaysAgo = t.resolvedAt ? Math.round(daysSince(t.resolvedAt, now)) : undefined;
  return {
    id: t.id,
    title: t.title,
    category: t.category,
    status: t.status,
    ...(resolvedDaysAgo === undefined || isOpenStatus(t.status) ? {} : { resolvedDaysAgo }),
  };
}
