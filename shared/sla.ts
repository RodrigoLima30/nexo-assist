import type { Priority, TicketStatus } from './domain';
import { isOpenStatus } from './domain';

/**
 * Prazos do Anexo A. O prazo vale para a primeira resposta e para cada atualização,
 * então é sempre contado a partir da última atualização do chamado.
 *
 * Horário útil: segunda a sexta, 8h–18h (horário de Brasília, UTC-3 fixo — o Brasil
 * não tem horário de verão desde 2019). Feriados não são considerados (simplificação).
 * Chamados críticos têm plantão 24 h, então o prazo de 1 hora é corrido.
 */
export type SlaRule =
  | { kind: 'hours'; amount: number; label: string }
  | { kind: 'business_hours'; amount: number; label: string }
  | { kind: 'business_days'; amount: number; label: string };

export const SLA_RULES: Record<Priority, SlaRule> = {
  critica: { kind: 'hours', amount: 1, label: '1 hora' },
  alta: { kind: 'business_hours', amount: 4, label: '4 horas úteis' },
  media: { kind: 'business_days', amount: 3, label: '3 dias úteis' },
  baixa: { kind: 'business_days', amount: 5, label: '5 dias úteis' },
};

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY_START = 8;
const DAY_END = 18;

/** "Relógio de parede" de Brasília representado num Date em UTC (use getUTC*). */
function toLocal(date: Date): Date {
  return new Date(date.getTime() + BRT_OFFSET_MS);
}
function fromLocal(local: Date): Date {
  return new Date(local.getTime() - BRT_OFFSET_MS);
}

function isWeekend(local: Date): boolean {
  const d = local.getUTCDay();
  return d === 0 || d === 6;
}

function atHour(local: Date, hour: number): Date {
  const copy = new Date(local);
  copy.setUTCHours(hour, 0, 0, 0);
  return copy;
}

/** Leva um instante (local) para o próximo momento dentro do horário útil. */
function normalizeToBusiness(local: Date): Date {
  let cur = new Date(local);
  for (;;) {
    if (isWeekend(cur)) {
      cur = atHour(new Date(cur.getTime() + 24 * HOUR), DAY_START);
      continue;
    }
    const h = cur.getUTCHours() + cur.getUTCMinutes() / 60;
    if (h < DAY_START) return atHour(cur, DAY_START);
    if (h >= DAY_END) {
      cur = atHour(new Date(cur.getTime() + 24 * HOUR), DAY_START);
      continue;
    }
    return cur;
  }
}

export function addBusinessHours(from: Date, hours: number): Date {
  let cur = normalizeToBusiness(toLocal(from));
  let remaining = hours * HOUR;
  while (remaining > 0) {
    const endOfDay = atHour(cur, DAY_END);
    const available = endOfDay.getTime() - cur.getTime();
    if (remaining <= available) {
      cur = new Date(cur.getTime() + remaining);
      remaining = 0;
    } else {
      remaining -= available;
      cur = normalizeToBusiness(new Date(endOfDay.getTime() + 1));
    }
  }
  return fromLocal(cur);
}

export function addBusinessDays(from: Date, days: number): Date {
  let cur = normalizeToBusiness(toLocal(from));
  let added = 0;
  while (added < days) {
    cur = new Date(cur.getTime() + 24 * HOUR);
    if (!isWeekend(cur)) added++;
  }
  return fromLocal(cur);
}

export function computeDueAt(priority: Priority, from: Date): Date {
  const rule = SLA_RULES[priority];
  switch (rule.kind) {
    case 'hours':
      return new Date(from.getTime() + rule.amount * HOUR);
    case 'business_hours':
      return addBusinessHours(from, rule.amount);
    case 'business_days':
      return addBusinessDays(from, rule.amount);
  }
}

export interface SlaStatus {
  /** Prazo da próxima resposta/atualização (ISO). Nulo se o chamado está encerrado. */
  dueAt: string | null;
  overdue: boolean;
  ruleLabel: string;
}

export function slaStatus(
  ticket: { priority: Priority; status: TicketStatus; updatedAt: string },
  now: Date,
): SlaStatus {
  const rule = SLA_RULES[ticket.priority];
  if (!isOpenStatus(ticket.status)) return { dueAt: null, overdue: false, ruleLabel: rule.label };
  const due = computeDueAt(ticket.priority, new Date(ticket.updatedAt));
  return { dueAt: due.toISOString(), overdue: now.getTime() > due.getTime(), ruleLabel: rule.label };
}

// ---------------------------------------------------------------------------
// Formatação em pt-BR (horário de Brasília)
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatTime(iso: string): string {
  const l = toLocal(new Date(iso));
  return `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

export function formatDay(iso: string): string {
  const l = toLocal(new Date(iso));
  return `${pad(l.getUTCDate())} ${MONTHS[l.getUTCMonth()]}`;
}

export function formatDateTime(iso: string): string {
  return `${formatDay(iso)}, ${formatTime(iso)}`;
}

function localDayNumber(date: Date): number {
  return Math.floor(toLocal(date).getTime() / (24 * HOUR));
}

/** "13:43", "amanhã, 10:00" ou "30 out, 14:20". */
export function formatDue(iso: string, now: Date): string {
  const diffDays = localDayNumber(new Date(iso)) - localDayNumber(now);
  if (diffDays === 0) return formatTime(iso);
  if (diffDays === 1) return `amanhã, ${formatTime(iso)}`;
  return formatDateTime(iso);
}

/** "agora", "há 25 min", "há 3 h", "há 5 dias". */
export function formatRelative(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}

/** Horário da lista de conversas: "10:05" hoje, "ontem" ou "24 out". */
export function formatListTime(iso: string, now: Date): string {
  const diff = localDayNumber(now) - localDayNumber(new Date(iso));
  if (diff <= 0) return formatTime(iso);
  if (diff === 1) return 'ontem';
  return formatDay(iso);
}

/** O instante está dentro do horário de atendimento (seg–sex, 8h–18h)? */
export function isBusinessTime(date: Date): boolean {
  const l = toLocal(date);
  const h = l.getUTCHours();
  return !isWeekend(l) && h >= DAY_START && h < DAY_END;
}
