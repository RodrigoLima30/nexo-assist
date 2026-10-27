import { z } from 'zod';
import { CATEGORIES, IMPACTS, TICKET_TYPES, type Person } from '@shared/domain';
import type { Intent } from '@shared/chat';
import type { IssueSlots, Pending } from '../state';
import type { ArticleHit } from '../../helpcenter/search';

const INTENTS = [
  'greeting',
  'faq',
  'report_issue',
  'request',
  'ticket_status',
  'add_info',
  'talk_to_human',
  'out_of_scope',
  'answer_pending',
  'thanks',
  'unclear',
] as const satisfies readonly Intent[];

/**
 * O que o interpretador extrai de uma mensagem livre. O LLM só preenche fatos e
 * intenção; quem decide a ação (e aplica as regras do Anexo A) é o motor do agent.
 */
export const interpretationSchema = z.object({
  intent: z.enum(INTENTS).describe('Intenção principal da última mensagem do funcionário.'),
  confidence: z.number().min(0).max(1).describe('Segurança sobre a intenção e os fatos, de 0 a 1.'),
  understood: z.string().describe('O que você entendeu, em uma frase em português, na 2ª pessoa ("Você...").'),
  reasoning: z.string().describe('Por que essa intenção, em uma ou duas frases.'),
  ticketRef: z
    .string()
    .nullable()
    .describe('Número de chamado citado (ex.: INC-20311) ou escolhido entre os do funcionário pelo assunto; null se nenhum.'),
  issueTitle: z.string().nullable().describe('Título curto e objetivo para um chamado (até 70 caracteres), se for problema/pedido.'),
  issueDescription: z
    .string()
    .nullable()
    .describe('Descrição completa para o analista, só com fatos ditos pelo funcionário; null se não for problema/pedido.'),
  ticketType: z.enum(TICKET_TYPES).nullable().describe('INC se algo parou/não funciona; REQ se é pedido de acesso, equipamento ou software.'),
  category: z.enum(CATEGORIES).nullable(),
  impact: z.enum(IMPACTS).nullable().describe('Quem é afetado: self (só a pessoa), team, company, unknown (disse que não sabe).'),
  blocked: z.boolean().nullable().describe('A pessoa está impedida de trabalhar? null se não disse.'),
  deadlineToday: z.boolean().nullable().describe('Há compromisso hoje em risco (reunião, entrega, cliente)? null se não disse.'),
  deadlineText: z.string().nullable().describe('O compromisso citado, ex.: "reunião com cliente às 14h".'),
  hasWorkaround: z.boolean().nullable().describe('Existe alternativa para continuar trabalhando? null se não disse.'),
  relatedTicketId: z
    .string()
    .nullable()
    .describe('Se o problema é o mesmo de um chamado listado (aberto ou resolvido recentemente), o número dele.'),
  articleId: z.string().nullable().describe('Artigo da central que responde/trata o assunto, entre os fornecidos.'),
  articleApplies: z
    .boolean()
    .nullable()
    .describe('O artigo vale para o caso dessa pessoa (considere o sistema operacional e as condições do artigo)?'),
  answer: z
    .string()
    .nullable()
    .describe('Para dúvidas: resposta curta baseada SOMENTE no artigo fornecido. null se não houver artigo adequado.'),
  extraInfo: z.string().nullable().describe('Informação nova a acrescentar em um chamado existente.'),
  confirmation: z.enum(['yes', 'no']).nullable().describe('Se a mensagem responde sim/não à pergunta pendente.'),
  outOfScopeArea: z.enum(['RH', 'Financeiro', 'Facilities', 'Outro']).nullable(),
});

export type Interpretation = z.infer<typeof interpretationSchema>;

export interface TicketBrief {
  id: string;
  title: string;
  category: string;
  status: string;
  resolvedDaysAgo?: number;
}

export interface InterpreterContext {
  user: Person;
  text: string;
  pending: Pending | null;
  slots: IssueSlots | null;
  focusTicketId: string | null;
  openTickets: TicketBrief[];
  recentlyResolved: TicketBrief[];
  articles: ArticleHit[];
  history: { author: string; text: string }[];
}

export interface InterpretResult {
  interpretation: Interpretation;
  source: 'llm' | 'offline' | 'fallback';
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Por que caiu no modo offline, quando for o caso. */
  fallbackReason?: string;
}

export interface Interpreter {
  readonly name: string;
  interpret(ctx: InterpreterContext): Promise<InterpretResult>;
}
