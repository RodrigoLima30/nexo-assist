import type { Impact, Priority, TicketType } from './domain';

/**
 * Classificação de prioridade do Anexo A: impacto (quantas pessoas) × urgência
 * (compromisso em risco). É uma função pura e determinística de propósito: o LLM
 * extrai os fatos (impacto, se a pessoa está parada, se há compromisso hoje), mas
 * quem aplica a regra é o código — assim a prioridade é auditável e testável.
 */
export interface PriorityFacts {
  type: TicketType;
  impact: Impact;
  /** A pessoa (ou equipe) está impedida de trabalhar. */
  blocked: boolean | null;
  /** Há um compromisso no mesmo dia em risco. */
  deadlineToday: boolean | null;
  /** Existe alternativa para continuar trabalhando. */
  hasWorkaround: boolean | null;
}

export interface PriorityDecision {
  priority: Priority;
  /** Explicação curta, para o funcionário. */
  reason: string;
  /** Linha da tabela do Anexo A aplicada, para a trilha de decisão. */
  rule: string;
}

export const PRIORITY_RULES: Record<Priority, string> = {
  critica: 'Crítica: algo parado para uma equipe ou para a empresa (prazo de 1 hora).',
  alta: 'Alta: impede uma pessoa de trabalhar, ou há um compromisso no mesmo dia (4 horas úteis).',
  media: 'Média: atrapalha, mas há alternativa (3 dias úteis).',
  baixa: 'Baixa: pedidos e melhorias sem urgência (5 dias úteis).',
};

export function classifyPriority(f: PriorityFacts): PriorityDecision {
  const many = f.impact === 'team' || f.impact === 'company';
  const who = f.impact === 'company' ? 'a empresa toda' : 'a sua equipe';

  if (many && f.type === 'INC' && f.hasWorkaround !== true) {
    return {
      priority: 'critica',
      reason: `afeta ${who} e não há alternativa`,
      rule: PRIORITY_RULES.critica,
    };
  }
  if (f.deadlineToday === true) {
    return {
      priority: 'alta',
      reason: 'há um compromisso hoje que depende disso',
      rule: PRIORITY_RULES.alta,
    };
  }
  if (f.blocked === true) {
    return {
      priority: 'alta',
      reason: many ? `${who} está impedida de trabalhar` : 'você está impedido(a) de trabalhar',
      rule: PRIORITY_RULES.alta,
    };
  }
  if (f.type === 'INC' || many) {
    return {
      priority: 'media',
      reason: 'atrapalha, mas existe alternativa para seguir trabalhando',
      rule: PRIORITY_RULES.media,
    };
  }
  return {
    priority: 'baixa',
    reason: 'é um pedido sem urgência',
    rule: PRIORITY_RULES.baixa,
  };
}
