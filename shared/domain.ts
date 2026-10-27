/**
 * Vocabulário do service desk (Anexo A do PRD). Compartilhado entre interface, API, agent
 * e serviço de chamados para que todos falem exatamente a mesma língua.
 */

export const TICKET_TYPES = ['INC', 'REQ'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const CATEGORIES = ['Acesso', 'Rede e VPN', 'Hardware', 'Software', 'E-mail', 'Outros'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['critica', 'alta', 'media', 'baixa'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const IMPACTS = ['self', 'team', 'company', 'unknown'] as const;
export type Impact = (typeof IMPACTS)[number];

export const TICKET_STATUSES = [
  'novo',
  'aguardando_analista',
  'em_andamento',
  'aprovado',
  'aguardando_usuario',
  'resolvido',
  'fechado',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const OPEN_STATUSES: readonly TicketStatus[] = [
  'novo',
  'aguardando_analista',
  'em_andamento',
  'aprovado',
  'aguardando_usuario',
];

export function isOpenStatus(status: TicketStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export const TYPE_LABEL: Record<TicketType, string> = { INC: 'Incidente', REQ: 'Requisição' };

export const PRIORITY_LABEL: Record<Priority, string> = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};

export const IMPACT_LABEL: Record<Impact, string> = {
  self: 'Somente você',
  team: 'Sua equipe',
  company: 'Toda a empresa',
  unknown: 'Não informado',
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  novo: 'Novo',
  aguardando_analista: 'Aguardando analista',
  em_andamento: 'Em andamento',
  aprovado: 'Aprovado',
  aguardando_usuario: 'Aguardando você',
  resolvido: 'Resolvido',
  fechado: 'Fechado',
};

export type TicketEventKind = 'created' | 'comment' | 'status' | 'transfer' | 'reopened';

export interface TicketEvent {
  at: string;
  kind: TicketEventKind;
  text: string;
  author: string;
}

export interface Ticket {
  id: string;
  type: TicketType;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  status: TicketStatus;
  requesterEmail: string;
  affected: Impact;
  assignedTeam: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  events: TicketEvent[];
}

/** Dados necessários para abrir um chamado — todos obrigatórios pelo Anexo A. */
export interface NewTicketInput {
  type: TicketType;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  affected: Impact;
  requesterEmail: string;
}

export type Role = 'employee' | 'analyst';

export interface Person {
  email: string;
  name: string;
  role: Role;
  department: string;
  /** Equipamento principal — usado para checar se um artigo da central se aplica. */
  device?: string;
  os?: string;
  /** Para analistas: equipe de suporte. */
  team?: 'Suporte N1' | 'Suporte N2';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
