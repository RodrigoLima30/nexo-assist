/**
 * Avaliação do interpretador: casos rotulados → acurácia de intenção e de fatos-chave.
 * Usa o LLM se houver chave configurada (NEXO_MODEL + chave do provedor); senão, o offline.
 *   npm run eval            # interpretador configurado
 *   NEXO_OFFLINE=true npm run eval
 */
import type { Intent } from '@shared/chat';
import type { Category, Impact } from '@shared/domain';
import { createInterpreter } from '../server/agent/interpreter';
import type { InterpreterContext, TicketBrief } from '../server/agent/interpreter/types';
import type { Pending } from '../server/agent/state';
import { requirePerson } from '../server/directory/people';
import { searchArticles } from '../server/helpcenter/search';

interface Case {
  text: string;
  intent: Intent;
  category?: Category;
  impact?: Impact;
  deadlineToday?: boolean;
  related?: string;
  pending?: Pending;
}

const ANA_OPEN: TicketBrief[] = [
  { id: 'INC-20311', title: 'Notebook lento após atualização do Windows', category: 'Hardware', status: 'aguardando_analista' },
  { id: 'INC-20298', title: 'Acesso à pasta Financeiro no SharePoint', category: 'Acesso', status: 'em_andamento' },
  { id: 'REQ-10442', title: 'Segundo monitor para home office', category: 'Hardware', status: 'aprovado' },
];
const ANA_RESOLVED: TicketBrief[] = [{ id: 'INC-20150', title: 'Senha do SAP bloqueada', category: 'Acesso', status: 'resolvido', resolvedDaysAgo: 4 }];

const CASES: Case[] = [
  { text: 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.', intent: 'report_issue', category: 'Rede e VPN' },
  { text: 'O Outlook não abre, dá erro de perfil', intent: 'report_issue', category: 'E-mail' },
  { text: 'A impressora do 3º andar não imprime nada', intent: 'report_issue', category: 'Hardware' },
  { text: 'A internet caiu para toda a equipe, ninguém consegue trabalhar', intent: 'report_issue', category: 'Rede e VPN', impact: 'company' },
  { text: 'Preciso de acesso ao Power BI do comercial', intent: 'request', category: 'Acesso' },
  { text: 'Gostaria de solicitar um mouse sem fio novo', intent: 'request', category: 'Hardware' },
  { text: 'Qual o status do meu chamado?', intent: 'ticket_status' },
  { text: 'Como está o meu pedido do monitor?', intent: 'ticket_status' },
  { text: 'Tem novidade do INC-20298?', intent: 'ticket_status' },
  { text: 'Quero adicionar uma informação ao INC-20298: a pasta é Fechamento/2026', intent: 'add_info' },
  { text: 'Qual o horário de atendimento do service desk?', intent: 'faq' },
  { text: 'Como faço para configurar o e-mail no celular?', intent: 'faq' },
  { text: 'Quero falar com um atendente humano', intent: 'talk_to_human' },
  { text: 'Como faço para marcar minhas férias?', intent: 'out_of_scope' },
  { text: 'Meu reembolso de viagem ainda não caiu', intent: 'out_of_scope' },
  { text: 'Oi, bom dia', intent: 'greeting' },
  { text: 'Valeu, resolveu!', intent: 'thanks' },
  { text: 'Meu notebook continua muito lento, travando ao abrir o Excel', intent: 'report_issue', related: 'INC-20311' },
  { text: 'A senha do SAP está bloqueada de novo', intent: 'report_issue', related: 'INC-20150' },
  { text: 'Só eu. Tenho reunião com um cliente às 14h', intent: 'answer_pending', impact: 'self', deadlineToday: true, pending: { kind: 'ask_impact' } },
  { text: 'Minha equipe inteira', intent: 'answer_pending', impact: 'team', pending: { kind: 'ask_impact' } },
  { text: 'blá blá xyz', intent: 'unclear' },
];

async function main() {
  const interpreter = createInterpreter();
  const user = requirePerson('ana.souza@nexo.com.br');
  let intentOk = 0;
  let factChecks = 0;
  let factOk = 0;
  let tokens = 0;
  const started = Date.now();
  console.log(`Interpretador: ${interpreter.name}\n`);

  for (const c of CASES) {
    const ctx: InterpreterContext = {
      user,
      text: c.text,
      pending: c.pending ?? null,
      slots: null,
      focusTicketId: null,
      openTickets: ANA_OPEN,
      recentlyResolved: ANA_RESOLVED,
      articles: searchArticles(c.text),
      history: [],
    };
    const r = await interpreter.interpret(ctx);
    const i = r.interpretation;
    if (r.usage) tokens += r.usage.inputTokens + r.usage.outputTokens;
    const misses: string[] = [];
    if (i.intent === c.intent) intentOk++;
    else misses.push(`intenção ${i.intent} ≠ ${c.intent}`);
    const check = (name: string, expected: unknown, got: unknown) => {
      if (expected === undefined) return;
      factChecks++;
      if (expected === got) factOk++;
      else misses.push(`${name} ${String(got)} ≠ ${String(expected)}`);
    };
    check('categoria', c.category, i.category);
    check('impacto', c.impact, i.impact);
    check('prazo hoje', c.deadlineToday, i.deadlineToday);
    check('relacionado', c.related, i.relatedTicketId);
    console.log(`${misses.length ? '✗' : '✓'} ${c.text}${misses.length ? `\n    ${misses.join('; ')}` : ''}`);
  }

  console.log(`\nIntenção: ${intentOk}/${CASES.length} (${Math.round((intentOk / CASES.length) * 100)}%)`);
  console.log(`Fatos:    ${factOk}/${factChecks} (${Math.round((factOk / Math.max(1, factChecks)) * 100)}%)`);
  console.log(`Tempo:    ${Date.now() - started} ms${tokens ? ` · ${tokens} tokens` : ''}`);
}

void main();
