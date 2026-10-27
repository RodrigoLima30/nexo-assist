import { Agent } from '@mastra/core/agent';
import { logger } from '../../lib/log';
import { interpretOffline } from './offline';
import { interpretationSchema, type InterpretResult, type Interpreter, type InterpreterContext } from './types';

const log = logger('interpreter');

/**
 * Instruções do interpretador. O LLM NÃO decide a ação nem calcula prioridade/prazo:
 * ele entende a mensagem e extrai fatos. As regras do Anexo A são aplicadas em código,
 * o que deixa as decisões auditáveis, testáveis e baratas (uma chamada curta por mensagem).
 */
const INSTRUCTIONS = `Você é o módulo de compreensão do Nexo Assist, o agent do service desk de TI da Nexo.
Sua tarefa: ler a ÚLTIMA mensagem do funcionário, com o contexto fornecido, e devolver um JSON com a intenção e os fatos.
Você não conversa com o funcionário e não decide ações; outro componente aplica as regras.

Intenções:
- greeting: só um cumprimento.
- faq: dúvida que a central de ajuda pode responder (como fazer algo, horário, política).
- report_issue: algo parou ou não funciona (vira incidente, INC).
- request: pedido de acesso, equipamento ou software (vira requisição, REQ).
- ticket_status: quer saber como está um chamado (mesmo sem lembrar o número) ou se está atrasado.
- add_info: quer complementar um chamado existente com nova informação.
- talk_to_human: pede um analista/atendente/pessoa.
- out_of_scope: assunto que não é de TI (RH, financeiro, facilities).
- answer_pending: responde à pergunta pendente do agent (ver "pending").
- thanks: agradece ou encerra.
- unclear: não dá para saber o que a pessoa quer.

Regras de extração:
- Use apenas fatos ditos pelo funcionário ou presentes no contexto. Nunca invente números de chamado, prazos ou detalhes.
- ticketRef e relatedTicketId só podem ser números presentes em "openTickets" ou "recentlyResolved". Se a pessoa citar um número que não está nessas listas, copie o número em ticketRef mesmo assim (o sistema verifica a permissão).
- relatedTicketId: preencha se o problema descrito é o MESMO de um chamado listado (mesmo equipamento/sistema e sintoma).
- category: Acesso, Rede e VPN, Hardware, Software, E-mail ou Outros.
- impact: self se só a pessoa; team se a equipe/setor; company se a empresa toda; unknown se a pessoa disse que não sabe; null se não falou.
- blocked/deadlineToday/hasWorkaround: true/false só se a pessoa disse algo a respeito; caso contrário null.
- articleId: só entre os artigos fornecidos. articleApplies=false quando uma condição do artigo não vale para essa pessoa (ex.: artigo só para Windows 10 e a pessoa usa Windows 11).
- answer: só para faq, baseada exclusivamente no artigo; tom cordial, 1 a 3 frases, em português.
- issueTitle: até 70 caracteres, específico (ex.: "VPN não conecta no notebook — erro 809"). issueDescription: fatos objetivos para o analista, incluindo sintomas, desde quando, equipamento e o compromisso em risco, se houver.
- confidence: abaixo de 0.5 quando a mensagem for ambígua ou você estiver em dúvida.
- understood: uma frase na 2ª pessoa, ex.: "Você não consegue conectar na VPN (erro 809) e tem reunião às 14h."`;

export class LlmInterpreter implements Interpreter {
  readonly name = 'llm';
  private readonly agent: Agent;

  constructor(
    private readonly model: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.agent = new Agent({
      id: 'nexo-interpreter',
      name: 'Nexo Assist — interpretador',
      instructions: INSTRUCTIONS,
      model,
    });
  }

  async interpret(ctx: InterpreterContext): Promise<InterpretResult> {
    const prompt = buildPrompt(ctx);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.agent.generate(prompt, {
        structuredOutput: { schema: interpretationSchema },
        modelSettings: { temperature: 0, maxOutputTokens: 700 },
        abortSignal: controller.signal,
      });
      const parsed = interpretationSchema.parse(result.object);
      const usage = result.totalUsage ?? result.usage;
      return {
        interpretation: parsed,
        source: 'llm',
        model: this.model,
        usage: usage ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } : null,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('LLM falhou; usando interpretador offline', { reason });
      return { interpretation: interpretOffline(ctx), source: 'fallback', model: this.model, usage: null, fallbackReason: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Contexto compacto: só o necessário, para manter a chamada curta e barata. */
export function buildPrompt(ctx: InterpreterContext): string {
  const context = {
    employee: { name: ctx.user.name, department: ctx.user.department, device: ctx.user.device, os: ctx.user.os },
    pending: ctx.pending,
    collectedSoFar: ctx.slots
      ? {
          said: ctx.slots.utterances.slice(-4),
          category: ctx.slots.category,
          type: ctx.slots.type,
          impact: ctx.slots.impact,
          blocked: ctx.slots.blocked,
          deadlineToday: ctx.slots.deadlineToday,
        }
      : null,
    focusTicketId: ctx.focusTicketId,
    openTickets: ctx.openTickets,
    recentlyResolved: ctx.recentlyResolved,
    helpCenterArticles: ctx.articles.map((h) => ({
      id: h.article.id,
      title: h.article.title,
      body: h.article.body,
      onlyFor: h.article.appliesToOs ?? null,
    })),
    recentConversation: ctx.history.slice(-6),
  };
  return `Contexto:\n${JSON.stringify(context)}\n\nÚltima mensagem do funcionário:\n"""${ctx.text}"""`;
}
