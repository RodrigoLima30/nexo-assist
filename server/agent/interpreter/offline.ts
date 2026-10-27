import type { Category, Impact, TicketType } from '@shared/domain';
import { capitalize, fold, jaccard, tokens, truncate } from '../../lib/text';
import { articleAppliesTo } from '../../helpcenter/articles';
import { STRONG_MATCH } from '../../helpcenter/search';
import type { Interpretation, InterpretResult, Interpreter, InterpreterContext, TicketBrief } from './types';

/**
 * Interpretador sem LLM: regras e palavras-chave em português. Serve para três coisas:
 *  1. rodar o projeto sem chave de API (avaliação local, demonstração, CI);
 *  2. fallback quando o provedor de LLM falha ou demora demais;
 *  3. base determinística para os testes de cenário do motor do agent.
 * É deliberadamente conservador: quando não reconhece, devolve "unclear" com
 * confiança baixa, e o motor pergunta ou transfere em vez de chutar.
 */

const has = (text: string, re: RegExp) => re.test(text);

const RE = {
  ticketRef: /\b(INC|REQ)[\s-]?(\d{5})\b/i,
  greeting: /^(oi+|ola|bom dia|boa tarde|boa noite|e ai|hello|hey)\b[\s!,.]*([a-z]+[\s!,.]*)?$/,
  thanks: /\b(obrigad[oa]|valeu|agradeco|funcionou|deu certo|resolveu|era isso|perfeito)\b/,
  human: /\b(analista|atendente|humano|uma pessoa|alguem de verdade|falar com (alguem|uma pessoa)|suporte humano|transfer)/,
  status:
    /\b(status|andamento|como (esta|anda|ta)|meus? chamados?|minhas? (requisic|solicitac)|previsao|novidade|atualizac(ao|oes) (do|sobre)|atrasad|parado ha|ja (foi|resolveram))/,
  addInfo: /\b(complementar|acrescentar|adicionar (uma )?(informac|detalhe)|mais (uma )?informac|incluir no chamado|atualizar o chamado|esqueci de (dizer|falar|informar))/,
  problem:
    /\b(nao (funciona|conecta|liga|abre|imprime|consigo|carrega|entra|aparece|sincroniza|reconhece|toca|sai|responde)|erro|travou|travando|trava|lento|lentidao|caiu|parou|bloquead|quebr|sem (acesso|internet|rede|som|audio|video)|problema|falha|defeito|congel|tela azul|desligando|nao esta funcionando|fecha sozinh|fechando sozinh|crash)/,
  request:
    /\b(preciso de|gostaria de|quero (um|uma|acesso|instalar)|solicitar|solicito|pedir|pedido de|liberar|liberacao|acesso (a|ao|à)|instalar|instalacao|novo (notebook|monitor|mouse|teclado|celular)|segundo monitor|licenca)/,
  question: /(\?|^(como|qual|quais|quando|onde|posso|pode|tem como|existe|o que|e possivel)\b)/,
  outRh: /\b(ferias|salario|holerite|contracheque|folha de pagamento|beneficio|vale (refeicao|alimentacao|transporte)|plano de saude|ponto eletronico|banco de horas|rescisao|admissao|13o)\b/,
  outFin: /\b(reembolso|nota fiscal|pagamento de fornecedor|adiantamento|prestacao de contas|cartao corporativo)\b/,
  outFac: /\b(ar[- ]condicionado|limpeza|cadeira|estacionamento|copa|cafe|lampada|mesa nova|crach[aá]|manutencao predial|vazamento)\b/,
  impactSelf: /\b(so eu|somente eu|apenas eu|so comigo|so o meu|apenas o meu|eu mesm[oa]|so pra mim|so para mim)\b/,
  impactTeam: /\b(equipe|time|setor|departamento|area inteira|meus colegas|todo o (setor|time|andar)|varias pessoas|o andar)\b/,
  impactCompany: /\b(toda a empresa|empresa toda|todo mundo|todos os funcionarios|ninguem (consegue|esta conseguindo)|geral)\b/,
  dontKnow: /\b(nao sei|sei la|nao tenho certeza)\b/,
  blocked: /\b(nao consigo trabalhar|parad[oa]|impedid[oa]|nada funciona|impede|travad[oa] (de|sem)|sem conseguir trabalhar)\b/,
  deadline:
    /\b(reuniao|apresentacao|cliente|entrega|prazo|urgente|ainda hoje|para hoje|pra hoje|ate hoje|hoje (as|a tarde|de tarde|cedo)|daqui a pouco|as \d{1,2}(h|:\d{2}))/,
  workaround: /\b(consigo (trabalhar|usar|continuar)|da pra (usar|trabalhar)|tenho alternativa|uso o (celular|outro)|atrapalha|da para (usar|trabalhar)|contornar)\b/,
  noUrgency: /\b(sem urgencia|nao e urgente|pode esperar|sem pressa|quando der|tranquilo)\b/,
  yes: /^(sim|s|isso|pode|pode sim|claro|ok|confirmo|confirma|pode criar|pode abrir|manda|quero|por favor|beleza|positivo)\b/,
  no: /^(nao|n|nao obrigad|cancela|cancelar|deixa|deixa pra la|negativo|agora nao)\b/,
};

const CATEGORY_RULES: { category: Category; re: RegExp }[] = [
  { category: 'Rede e VPN', re: /\b(vpn|wi-?fi|internet|rede|conexao|conectar|cabo de rede|ping)\b/ },
  { category: 'E-mail', re: /\b(e-?mail|outlook|caixa de entrada|anexo|calendario|convite)\b/ },
  { category: 'Acesso', re: /\b(senha|acesso|permissao|login|bloquead|sap|sharepoint|pasta|perfil|usuario|mfa|autenticador)\b/ },
  { category: 'Software', re: /\b(instalar|programa|aplicativo|software|excel|word|teams|office|licenca|zoom|adobe|power ?bi|sistema)\b/ },
  {
    category: 'Hardware',
    re: /\b(notebook|computador|monitor|teclado|mouse|impressora|tela|bateria|lento|lentidao|carregador|headset|fone|webcam|camera|desktop|pc)\b/,
  },
];

const IMPACT_ANSWER: { impact: Impact; re: RegExp }[] = [
  { impact: 'company', re: RE.impactCompany },
  { impact: 'team', re: RE.impactTeam },
  { impact: 'self', re: RE.impactSelf },
  { impact: 'unknown', re: RE.dontKnow },
];

function detectImpact(t: string, answeringImpact: boolean): Impact | null {
  for (const { impact, re } of IMPACT_ANSWER) if (has(t, re)) return impact;
  if (answeringImpact && /^(eu|so eu|somente eu)\b/.test(t)) return 'self';
  return null;
}

/** A categoria com mais termos citados vence; empate fica com a ordem da lista. */
function detectCategory(t: string): Category | null {
  let best: { category: Category; n: number } | null = null;
  for (const { category, re } of CATEGORY_RULES) {
    const n = t.match(new RegExp(re.source, 'g'))?.length ?? 0;
    if (n > 0 && (!best || n > best.n)) best = { category, n };
  }
  return best?.category ?? null;
}

/** Texto a acrescentar no chamado: o que vem depois de ":" ou do número do chamado. */
function extractExtraInfo(original: string): string | null {
  const afterColon = original.split(/:\s*/).slice(1).join(': ').trim();
  if (afterColon.length >= 10) return afterColon;
  const afterRef = original.split(RE.ticketRef).at(-1)?.replace(/^[\s,.;-]+/, '').trim() ?? '';
  return afterRef.length >= 15 ? afterRef : null;
}

function deadlineText(original: string): string | null {
  const m =
    original.match(/(reuni[aã]o[^.,;!?]*)/i) ??
    original.match(/(apresenta[cç][aã]o[^.,;!?]*)/i) ??
    original.match(/(entrega[^.,;!?]*)/i) ??
    original.match(/(\b[àa]s?\s\d{1,2}(h|:\d{2})\d{0,2})/i);
  return m?.[1] ? truncate(m[1], 80) : null;
}

/** Título curto a partir da primeira frase relevante. */
export function deriveTitle(text: string): string {
  const cleaned = text
    .replace(/^(oi|ol[áa]|bom dia|boa tarde|boa noite)[,!.\s]+/i, '')
    .replace(/^(estou com (um )?problema:?\s*|tenho um problema:?\s*|preciso de ajuda:?\s*)/i, '');
  const first = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return capitalize(truncate(first.replace(/[.!?]+$/, ''), 70));
}

function matchTicketByWords(text: string, tickets: TicketBrief[]): TicketBrief | null {
  const tt = tokens(text);
  let best: { t: TicketBrief; s: number } | null = null;
  for (const t of tickets) {
    const s = jaccard(tt, tokens(t.title));
    if (s >= 0.15 && (!best || s > best.s)) best = { t, s };
  }
  return best?.t ?? null;
}

function base(): Interpretation {
  return {
    intent: 'unclear',
    confidence: 0.3,
    understood: 'Não consegui entender o que você precisa.',
    reasoning: 'Nenhum padrão conhecido foi reconhecido na mensagem.',
    ticketRef: null,
    issueTitle: null,
    issueDescription: null,
    ticketType: null,
    category: null,
    impact: null,
    blocked: null,
    deadlineToday: null,
    deadlineText: null,
    hasWorkaround: null,
    relatedTicketId: null,
    articleId: null,
    articleApplies: null,
    answer: null,
    extraInfo: null,
    confirmation: null,
    outOfScopeArea: null,
  };
}

export function interpretOffline(ctx: InterpreterContext): Interpretation {
  const original = ctx.text.trim();
  const t = fold(original);
  const out = base();
  const pending = ctx.pending?.kind ?? null;

  // Fatos que valem para qualquer intenção.
  const ref = original.match(RE.ticketRef);
  if (ref) out.ticketRef = `${ref[1]!.toUpperCase()}-${ref[2]}`;
  out.category = detectCategory(t);
  out.impact = detectImpact(t, pending === 'ask_impact');
  if (has(t, RE.blocked)) out.blocked = true;
  if (has(t, RE.deadline)) {
    out.deadlineToday = true;
    out.deadlineText = deadlineText(original);
  }
  if (has(t, RE.workaround)) {
    out.hasWorkaround = true;
    out.blocked = out.blocked ?? false;
  }
  if (has(t, RE.noUrgency)) {
    out.deadlineToday = false;
    out.blocked = false;
    out.hasWorkaround = true;
  }
  if (has(t, RE.yes)) out.confirmation = 'yes';
  else if (has(t, RE.no)) out.confirmation = 'no';

  const best = ctx.articles[0];
  const strongArticle = best && best.score >= STRONG_MATCH ? best.article : null;

  // 1. Pedidos explícitos que valem em qualquer momento.
  if (has(t, RE.human)) {
    return { ...out, intent: 'talk_to_human', confidence: 0.92, understood: 'Você quer falar com um analista.', reasoning: 'A mensagem pede um atendente humano.' };
  }
  const area = has(t, RE.outRh) ? 'RH' : has(t, RE.outFin) ? 'Financeiro' : has(t, RE.outFac) ? 'Facilities' : null;
  if (area && !has(t, RE.problem)) {
    return {
      ...out,
      intent: 'out_of_scope',
      outOfScopeArea: area,
      confidence: 0.85,
      understood: `Você tem uma questão de ${area}.`,
      reasoning: `O assunto é de ${area}, fora do escopo de TI.`,
    };
  }

  // 2. Respostas a perguntas pendentes.
  if (pending === 'ask_impact' && out.impact) {
    return { ...out, intent: 'answer_pending', confidence: 0.9, understood: 'Você informou quem está sendo afetado.', reasoning: 'Resposta à pergunta sobre impacto.' };
  }
  if (pending === 'ask_urgency' && (out.blocked !== null || out.deadlineToday !== null || out.hasWorkaround !== null)) {
    return { ...out, intent: 'answer_pending', confidence: 0.85, understood: 'Você informou a urgência.', reasoning: 'Resposta à pergunta sobre urgência.' };
  }
  if ((pending === 'offer_human' || pending === 'confirm_draft' || pending === 'article') && out.confirmation) {
    return {
      ...out,
      intent: 'answer_pending',
      confidence: 0.85,
      understood: out.confirmation === 'yes' ? 'Você respondeu que sim.' : 'Você respondeu que não.',
      reasoning: 'Resposta de sim/não à pergunta pendente.',
    };
  }
  if (pending === 'await_info' && original.length >= 4 && !has(t, RE.status)) {
    return { ...out, intent: 'add_info', extraInfo: original, confidence: 0.85, understood: 'Você enviou a informação para o chamado.', reasoning: 'O agent tinha pedido a informação a acrescentar.' };
  }
  if (pending === 'select_ticket') {
    const pendingIds = ctx.pending?.kind === 'select_ticket' ? ctx.pending.ticketIds : [];
    const pool = ctx.openTickets.filter((tk) => pendingIds.includes(tk.id));
    const match = out.ticketRef ? pool.find((tk) => tk.id === out.ticketRef) : matchTicketByWords(original, pool);
    if (match) {
      return { ...out, intent: 'answer_pending', ticketRef: match.id, confidence: 0.85, understood: `Você escolheu o ${match.id}.`, reasoning: 'Seleção entre os chamados listados.' };
    }
  }

  // 3. Intenções gerais.
  if (has(t, RE.greeting) && original.length < 30) {
    return { ...out, intent: 'greeting', confidence: 0.95, understood: 'Você me cumprimentou.', reasoning: 'Mensagem curta de saudação.' };
  }
  if (has(t, RE.thanks) && !has(t, RE.problem) && original.length < 80) {
    return { ...out, intent: 'thanks', confidence: 0.85, understood: 'Você agradeceu / encerrou o assunto.', reasoning: 'Mensagem de agradecimento.' };
  }
  if (has(t, RE.addInfo) || (out.ticketRef && /\b(tambem|alem disso|agora|mais)\b/.test(t) && !has(t, RE.status))) {
    return {
      ...out,
      intent: 'add_info',
      extraInfo: extractExtraInfo(original),
      confidence: 0.75,
      understood: 'Você quer complementar um chamado com novas informações.',
      reasoning: 'A mensagem pede para acrescentar informação a um chamado.',
    };
  }
  if (has(t, RE.status) || (out.ticketRef && !has(t, RE.problem))) {
    const related = out.ticketRef ? null : matchTicketByWords(original, ctx.openTickets);
    return {
      ...out,
      intent: 'ticket_status',
      ticketRef: out.ticketRef ?? related?.id ?? null,
      confidence: 0.85,
      understood: out.ticketRef ? `Você quer saber como está o ${out.ticketRef}.` : 'Você quer saber como estão seus chamados.',
      reasoning: 'A mensagem pergunta sobre o andamento de chamado.',
    };
  }

  const isProblem = has(t, RE.problem);
  const isRequest = has(t, RE.request);
  const isQuestion = has(t, RE.question);

  if (isQuestion && !isProblem && strongArticle) {
    return {
      ...out,
      intent: 'faq',
      articleId: strongArticle.id,
      articleApplies: articleAppliesTo(strongArticle, ctx.user.os),
      confidence: 0.8,
      understood: `Você tem uma dúvida sobre "${strongArticle.title.toLowerCase()}".`,
      reasoning: `Pergunta com artigo correspondente na central (${strongArticle.id}).`,
    };
  }

  if (isProblem || isRequest) {
    const type: TicketType = isProblem ? 'INC' : 'REQ';
    const related = findRelated(original, out.category, ctx);
    return {
      ...out,
      intent: type === 'INC' ? 'report_issue' : 'request',
      ticketType: type,
      issueTitle: deriveTitle(original),
      issueDescription: original,
      relatedTicketId: related,
      articleId: strongArticle?.id ?? null,
      articleApplies: strongArticle ? articleAppliesTo(strongArticle, ctx.user.os) : null,
      confidence: out.category ? 0.8 : 0.6,
      understood:
        type === 'INC'
          ? `Você relatou um problema${out.category ? ` de ${out.category}` : ''}.`
          : `Você fez um pedido${out.category ? ` de ${out.category}` : ''}.`,
      reasoning:
        type === 'INC'
          ? 'A mensagem descreve algo que parou ou não funciona (incidente).'
          : 'A mensagem pede acesso, equipamento ou software (requisição).',
    };
  }

  if (strongArticle) {
    return {
      ...out,
      intent: 'faq',
      articleId: strongArticle.id,
      articleApplies: articleAppliesTo(strongArticle, ctx.user.os),
      confidence: 0.65,
      understood: `Você quer saber sobre "${strongArticle.title.toLowerCase()}".`,
      reasoning: `O assunto corresponde ao artigo ${strongArticle.id}.`,
    };
  }

  // Com uma pergunta pendente, uma resposta curta e livre vira complemento da descrição.
  if ((pending === 'ask_details' || pending === 'ask_urgency' || pending === 'ask_impact') && original.length > 3) {
    return {
      ...out,
      intent: 'answer_pending',
      confidence: 0.55,
      understood: 'Você complementou a descrição do problema.',
      reasoning: 'Resposta livre à pergunta do agent; não reconheci um valor exato.',
    };
  }
  return out;
}

function findRelated(text: string, category: Category | null, ctx: InterpreterContext): string | null {
  const tt = tokens(text);
  const pool = [...ctx.openTickets, ...ctx.recentlyResolved];
  let best: { id: string; s: number } | null = null;
  for (const t of pool) {
    const shared = tokens(t.title).filter((w) => tt.includes(w));
    const sameCategory = category !== null && t.category === category;
    const s = shared.length + (sameCategory ? 1 : 0);
    if (shared.length >= 2 && sameCategory && (!best || s > best.s)) best = { id: t.id, s };
  }
  return best?.id ?? null;
}

export class OfflineInterpreter implements Interpreter {
  readonly name = 'offline';

  async interpret(ctx: InterpreterContext): Promise<InterpretResult> {
    return { interpretation: interpretOffline(ctx), source: 'offline', model: null, usage: null };
  }
}
