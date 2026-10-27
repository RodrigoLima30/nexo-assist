import type { TicketStatus } from '@shared/domain';

/** Cor do ponto de status, como no protótipo. */
export function statusColor(status: TicketStatus): string {
  switch (status) {
    case 'novo':
    case 'aguardando_analista':
    case 'aguardando_usuario':
      return 'var(--warning)';
    case 'em_andamento':
      return 'var(--primary)';
    case 'aprovado':
      return 'var(--success)';
    case 'resolvido':
    case 'fechado':
      return '#1B243140';
  }
}

export function statusTextColor(status: TicketStatus): string {
  switch (status) {
    case 'novo':
    case 'aguardando_analista':
    case 'aguardando_usuario':
      return 'var(--warning-text)';
    case 'em_andamento':
      return 'var(--primary-text)';
    case 'aprovado':
      return 'var(--success-text)';
    default:
      return 'var(--ink-3)';
  }
}

export function priorityColor(p: string): string {
  return p === 'critica' ? 'var(--danger)' : p === 'alta' ? 'var(--warning)' : p === 'media' ? '#1B243166' : '#1B243133';
}

const AVATAR_COLORS: [string, string][] = [
  ['#DCE9F7', '#0062C4'],
  ['#F6E3D3', '#9A4A12'],
  ['#E6E1F7', '#5B3FC4'],
  ['#DDF0E6', '#1E7A4C'],
  ['#F7E1E6', '#A3324F'],
  ['#E5E8EC', '#3D4656'],
  ['#FBEFD0', '#8A6100'],
];

export function avatarColors(seed: string): [string, string] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
