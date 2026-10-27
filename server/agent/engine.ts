import type { Category, Impact, Person, Priority, Ticket } from '@shared/domain';
import { CATEGORIES, IMPACTS, IMPACT_LABEL, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, firstName, isOpenStatus } from '@shared/domain';
import type {
  Block,
  ClientAction,
  DecisionTrace,
  Draft,
  DraftEdits,
  DraftState,
  Handoff,
  HandoffKind,
  Intent,
  QuickOption,
  TraceStep,
} from '@shared/chat';
import { INTENT_LABEL } from '@shared/chat';
import { classifyPriority } from '@shared/priority';
import { SLA_RULES, computeDueAt, formatDue, formatRelative, isBusinessTime, slaStatus } from '@shared/sla';
import { TicketsUnavailableError, type CallInfo, type TicketsClient } from '../clients/tickets-client';
import { articleAppliesTo, getArticle, type Article } from '../helpcenter/articles';
import { searchArticles, STRONG_MATCH } from '../helpcenter/search';
import { truncate } from '../lib/text';
import { buildHandoffSummary, HANDOFF_REASON, teamFor } from './handoff';
import type { Interpretation, Interpreter } from './interpreter/types';
import { emptySlots, type AgentState, type IssueSlots } from './state';
import { Tracer } from './tracer';
import { brief, daysSince, toSummary, toView } from './views';

/**
 * Motor de decisão do Nexo Assist.
 *
 * A cada mensagem: (1) carrega o contexto (chamados do funcionário, artigos da central),
 * (2) pede ao interpretador a intenção e os fatos, (3) aplica as regras do service desk
 * (Anexo A) em código para escolher a ação, e (4) devolve a resposta com uma trilha de
 * decisão completa: o que entendeu, que ação tomou, com que segurança e por quê.
 *
 * Cliques em opções (ações estruturadas) não passam pelo LLM: já sabemos a intenção.
 */

export const AGENT_NAME = 'Nexo Assist';
/** Abaixo disso o agent não age: pergunta. Duas vezes seguidas, chama um analista. */
export const MIN_CONFIDENCE = 0.5;
export const LOW_CONFIDENCE_STREAK_TO_HANDOFF = 2;

export const RULES = {
  draft: 'Abertura: o agent mostra um rascunho e só cria ou atualiza depois da confirmação do funcionário.',
  required: 'Todo chamado precisa de título, descrição, tipo, categoria, prioridade e de quem é afetado.',
  duplicate: 'Sem duplicidade: se já existe um chamado aberto sobre o mesmo problema, ele é atualizado.',
  reopen: 'Chamados resolvidos há até 7 dias podem ser reabertos.',
  privacy: 'Privacidade: informações de um chamado só podem ser passadas a quem o abriu.',
  scope: 'Escopo: apenas assuntos de TI; RH, financeiro e facilities são redirecionados.',
  handoff: 'Transferência: quando o funcionário pede, em casos críticos, em chamados vencidos ou quando o agent não tem segurança.',
  paused: 'O agent não responde enquanto a conversa está com um analista.',
  sla: 'O prazo vale para a primeira resposta e para cada atualização; passado o prazo, o chamado está vencido.',
} as const;

export interface TurnInput {
  conversationId: string;
  user: Person;
  state: AgentState;
  text: string;
  action: ClientAction | null;
  history: { author: string; text: string }[];
}

export interface TurnOutput {
  text: string;
  blocks: Block[];
  trace: DecisionTrace;
  state: AgentState;
  handoff: Handoff | null;
  resolved: boolean;
  draftResolution: { draftId: string; state: DraftState; resultTicketId: string | null } | null;
}

export interface EngineDeps {
  tickets: TicketsClient;
  interpreter: Interpreter;
  now?: () => Date;
}

export class AgentEngine {
  constructor(private readonly deps: EngineDeps) {}

  async handle(input: TurnInput, onStep?: (step: TraceStep) => void): Promise<TurnOutput> {
    const run = new TurnRun(this.deps, input, new Tracer(onStep));
    return run.execute();
  }
}

interface Reply {
  text: string;
  blocks?: Block[];
  action: { code: string; label: string };
}

const OUT_OF_SCOPE_CHANNEL: Record<string, string> = {
  RH: 'Fale com o RH pelo portal rh.nexo.com.br ou pelo ramal 4100.',
  Financeiro: 'Fale com o Financeiro pelo e-mail financeiro@nexo.com.br ou pelo ramal 4300.',
  Facilities: 'Abra uma solicitação para Facilities pelo ramal 4200 ou facilities@nexo.com.br.',
  Outro: 'Procure a área responsável pela intranet (intranet.nexo.com.br › Quem atende o quê).',
};

const START_OPTIONS: QuickOption[] = [
  { label: 'Tenho um problema', action: { type: 'start', topic: 'problem' } },
  { label: 'Consultar meus chamados', action: { type: 'start', topic: 'status' } },
  { label: 'Tirar uma dúvida', action: { type: 'start', topic: 'question' } },
];

const IMPACT_OPTIONS: QuickOption[] = [
  { label: 'Só eu', action: { type: 'answer', field: 'impact', value: 'self' } },
  { label: 'Minha equipe', action: { type: 'answer', field: 'impact', value: 'team' } },
  { label: 'Toda a empresa', action: { type: 'answer', field: 'impact', value: 'company' } },
  { label: 'Não sei', action: { type: 'answer', field: 'impact', value: 'unknown' } },
];

class TurnRun {
  private readonly now: Date;
  private readonly state: AgentState;
  private readonly rules = new Set<string>();
  private readonly facts: Record<string, string> = {};
  private intent: Intent = 'unclear';
  private understood = '';
  private reasoning = '';
  private confidence = 1;
  private source: DecisionTrace['interpreter'] = 'action';
  private model: string | null = null;
  private usage: DecisionTrace['usage'] = null;
  private handoff: Handoff | null = null;
  private resolved = false;
  private draftResolution: TurnOutput['draftResolution'] = null;
  private allTickets: Ticket[] = [];
  private ticketsLoaded = false;
  private ticketsDown = false;
  private readonly started = performance.now();

  constructor(
    private readonly deps: EngineDeps,
    private readonly input: TurnInput,
    private readonly tracer: Tracer,
  ) {
    this.now = deps.now?.() ?? new Date();
    this.state = structuredClone(input.state);
  }

  private get user(): Person {
    return this.input.user;
  }

  private get openTickets(): Ticket[] {
    return this.allTickets.filter((t) => isOpenStatus(t.status));
  }

  private get recentlyResolved(): Ticket[] {
    return this.allTickets.filter((t) => t.status === 'resolvido' && t.resolvedAt && daysSince(t.resolvedAt, this.now) <= 7);
  }

  async execute(): Promise<TurnOutput> {
    const reply = this.input.action ? await this.handleAction(this.input.action) : await this.handleText(this.input.text);
    return this.finish(reply);
  }

  // -------------------------------------------------------------------------
  // Mensagens livres
  // -------------------------------------------------------------------------

  private async handleText(text: string): Promise<Reply> {
    await this.loadTickets(false);
    const searchText = [text, ...(this.state.slots?.utterances.slice(-2) ?? [])].join(' ');
    const hits = searchArticles(searchText);
    this.tracer.note('buscou na central de ajuda', 'helpcenter.search', hits.length ? hits.map((h) => `${h.article.id} (${h.score})`).join(', ') : 'nenhum artigo', {
      visible: false,
      input: { query: truncate(searchText, 160) },
      output: hits.map((h) => ({ id: h.article.id, title: h.article.title, score: h.score })),
    });

    const result = await this.tracer.run(
      'interpretou a mensagem',
      `interpreter.${this.deps.interpreter.name}`,
      () =>
        this.deps.interpreter.interpret({
          user: this.user,
          text,
          pending: this.state.pending,
          slots: this.state.slots,
          focusTicketId: this.state.focusTicketId,
          openTickets: this.openTickets.map((t) => brief(t, this.now)),
          recentlyResolved: this.recentlyResolved.map((t) => brief(t, this.now)),
          articles: hits,
          history: this.input.history,
        }),
      {
        visible: false,
        input: { text, pending: this.state.pending?.kind ?? null },
        summarize: (r) => ({
          detail: `${r.source === 'fallback' ? 'LLM indisponível → regras offline · ' : ''}${INTENT_LABEL[r.interpretation.intent]} · ${Math.round(r.interpretation.confidence * 100)}%`,
          output: r.interpretation,
        }),
      },
    );
    const i = this.sanitize(result.interpretation);
    this.source = result.source;
    this.model = result.model;
    this.usage = result.usage;
    this.intent = i.intent;
    this.understood = i.understood;
    this.reasoning = i.reasoning;
    this.confidence = i.confidence;
    this.collectFacts(i);
    if (result.source === 'fallback') this.facts['Interpretação'] = 'regras offline (LLM indisponível)';

    // Pedidos que valem em qualquer ponto da conversa.
    if (i.intent === 'talk_to_human') return this.transfer(this.state.focusTicketId && this.isOverdue(this.state.focusTicketId) ? 'overdue' : 'user_request');
    if (i.intent === 'out_of_scope') return this.outOfScope(i);

    const lowConfidence = i.confidence < MIN_CONFIDENCE && !['greeting', 'thanks'].includes(i.intent);
    if (i.intent === 'unclear' || lowConfidence) return this.clarify(i);
    this.state.lowConfidenceStreak = 0;

    const pendingReply = await this.handlePending(i, text);
    if (pendingReply) return pendingReply;

    switch (i.intent) {
      case 'greeting':
        return this.greet();
      case 'thanks':
        return this.thanks();
      case 'faq':
        return this.answerFaq(i, text);
      case 'ticket_status':
        return this.ticketStatus(i.ticketRef, i);
      case 'add_info':
        return this.addInfo(i.ticketRef, i.extraInfo);
      case 'report_issue':
      case 'request':
        // Nenhuma pergunta pendente absorveu a mensagem: é um assunto novo. Começa do zero
        // para não herdar categoria nem a checagem de duplicidade de um assunto anterior.
        this.state.slots = emptySlots();
        return this.newIssue(i, text);
      case 'answer_pending':
        // Resposta sem pergunta pendente correspondente: tratamos como relato livre se houver slots.
        if (this.state.slots) return this.newIssue(i, text);
        return this.clarify(i);
      default:
        return this.clarify(i);
    }
  }

  /** Respostas a perguntas que o agent deixou em aberto. Devolve null para seguir o fluxo geral. */
  private async handlePending(i: Interpretation, text: string): Promise<Reply | null> {
    const p = this.state.pending;
    if (!p) return null;
    const changedSubject = ['ticket_status', 'faq', 'greeting'].includes(i.intent) && i.confidence >= 0.7;

    switch (p.kind) {
      case 'ask_impact':
      case 'ask_urgency':
      case 'ask_details':
        if (changedSubject) return null;
        if (i.intent === 'answer_pending' || i.intent === 'report_issue' || i.intent === 'request' || i.intent === 'add_info') {
          return this.newIssue(i, text);
        }
        return null;
      case 'article':
        if (i.intent === 'thanks' || i.confirmation === 'yes') return this.articleResolved();
        if (i.confirmation === 'no' || i.intent === 'report_issue') {
          this.slots().articleChecked = true;
          return this.newIssue(i, text);
        }
        return null;
      case 'select_ticket': {
        if (i.ticketRef && p.ticketIds.includes(i.ticketRef)) {
          return p.purpose === 'status' ? this.ticketStatus(i.ticketRef, i) : this.addInfo(i.ticketRef, null);
        }
        return null;
      }
      case 'offer_human':
        if (i.confirmation === 'yes') return this.transfer(p.ticketId && this.isOverdue(p.ticketId) ? 'overdue' : 'user_request');
        if (i.confirmation === 'no') return this.decline();
        return null;
      case 'await_info':
        if (changedSubject && i.intent !== 'add_info') return null;
        return this.buildUpdateDraft(p.ticketId, i.extraInfo ?? text);
      case 'confirm_draft':
        if (i.confirmation === 'yes') return this.confirmDraft(p.draftId, undefined);
        if (i.confirmation === 'no') return this.cancelDraft(p.draftId);
        if (i.intent === 'answer_pending' || i.intent === 'report_issue' || i.intent === 'request') {
          // Correção ou detalhe novo enquanto o rascunho está aberto: refaz o rascunho com o fato novo.
          if (this.state.draft?.mode === 'create') {
            this.mergeSlots(i, text);
            return this.composeDraft(null, 'Atualizei o rascunho com o que você disse. Confira de novo:');
          }
        }
        return null;
      case 'clarify':
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Ações estruturadas (cliques)
  // -------------------------------------------------------------------------

  private async handleAction(action: ClientAction): Promise<Reply> {
    this.source = 'action';
    this.confidence = 1;
    this.facts['Origem'] = 'clique em uma opção';
    switch (action.type) {
      case 'start':
        if (action.topic === 'status') {
          this.setUnderstanding('ticket_status', 'Você quer consultar seus chamados.', 'Opção "Consultar meus chamados".');
          await this.loadTickets(true);
          return this.ticketStatus(null, null);
        }
        this.setUnderstanding('greeting', 'Você quer começar um atendimento.', 'Opção do menu inicial.');
        this.state.pending = null;
        this.state.slots = null;
        return action.topic === 'problem'
          ? { text: 'Claro. Me conte o que está acontecendo, com suas palavras: o que não funciona, desde quando e em qual equipamento ou sistema.', action: { code: 'ask_description', label: 'Pediu a descrição do problema' } }
          : { text: 'Pode perguntar! Eu busco a resposta na central de ajuda.', action: { code: 'ask_question', label: 'Pediu a dúvida' } };

      case 'answer': {
        const slots = this.state.slots;
        if (!slots) return this.staleAction();
        if (action.field === 'impact') {
          slots.impact = action.value;
          this.setUnderstanding('answer_pending', `Afetados: ${IMPACT_LABEL[action.value].toLowerCase()}.`, 'Resposta à pergunta sobre impacto.');
        } else {
          const v = action.value;
          slots.blocked = v === 'blocked';
          slots.deadlineToday = v === 'deadline';
          slots.hasWorkaround = v === 'workaround' || v === 'none';
          this.setUnderstanding('answer_pending', 'Você informou a urgência.', 'Resposta à pergunta sobre urgência.');
        }
        await this.loadTickets(false);
        return this.continueIssue(null);
      }

      case 'select_ticket':
        this.setUnderstanding('ticket_status', `Você escolheu o ${action.ticketId}.`, 'Seleção na lista de chamados.');
        await this.loadTickets(false);
        return action.purpose === 'status' ? this.ticketStatus(action.ticketId, null) : this.addInfo(action.ticketId, null);

      case 'request_human': {
        this.setUnderstanding('talk_to_human', 'Você quer falar com um analista.', 'Opção "Falar com um analista".');
        await this.loadTickets(false);
        const focus = this.state.focusTicketId;
        return this.transfer(focus && this.isOverdue(focus) ? 'overdue' : 'user_request');
      }

      case 'add_info':
        this.setUnderstanding('add_info', `Você quer complementar o ${action.ticketId}.`, 'Opção "Adicionar informação".');
        await this.loadTickets(false);
        return this.addInfo(action.ticketId, null);

      case 'decline':
        this.setUnderstanding('thanks', 'Você não precisa de mais nada agora.', 'Opção "Não, obrigado".');
        return this.decline();

      case 'article_resolved':
        this.setUnderstanding('thanks', 'O artigo resolveu.', 'Opção "Isso resolveu".');
        return this.articleResolved();

      case 'article_not_resolved':
      case 'open_new': {
        this.setUnderstanding(
          'report_issue',
          action.type === 'open_new' ? 'É um problema diferente; você quer um chamado novo.' : 'O artigo não resolveu.',
          'Opção escolhida no chat.',
        );
        const slots = this.state.slots;
        if (!slots) return this.staleAction();
        slots.articleChecked = true;
        slots.duplicateChecked = true;
        await this.loadTickets(false);
        return this.continueIssue(null);
      }

      case 'confirm_draft':
        this.setUnderstanding('answer_pending', 'Você confirmou o rascunho.', 'Botão "Confirmar".');
        return this.confirmDraft(action.draftId, action.edits);

      case 'cancel_draft':
        this.setUnderstanding('answer_pending', 'Você cancelou o rascunho.', 'Botão "Cancelar".');
        return this.cancelDraft(action.draftId);
    }
  }

  // -------------------------------------------------------------------------
  // Fluxos
  // -------------------------------------------------------------------------

  private greet(): Reply {
    this.state.pending = null;
    return {
      text: `Oi, ${firstName(this.user.name)}! Sou o Nexo Assist, do service desk de TI. Me conte o que está acontecendo — posso tirar dúvidas, consultar seus chamados ou abrir um novo.`,
      blocks: [{ kind: 'options', question: null, options: START_OPTIONS }],
      action: { code: 'greet', label: 'Cumprimentou e ofereceu opções' },
    };
  }

  private thanks(): Reply {
    this.state.pending = null;
    this.resolved = true;
    return { text: 'Por nada! Se precisar de mais alguma coisa de TI, é só escrever aqui.', action: { code: 'close', label: 'Encerrou o assunto' } };
  }

  private decline(): Reply {
    this.state.pending = null;
    return { text: 'Certo! Se precisar de mais alguma coisa, é só escrever.', action: { code: 'acknowledge', label: 'Registrou que não precisa de mais nada' } };
  }

  private articleResolved(): Reply {
    this.state.pending = null;
    this.state.slots = null;
    this.resolved = true;
    return {
      text: 'Que ótimo que resolveu! Não precisei abrir chamado. Se voltar a acontecer, é só me chamar.',
      action: { code: 'resolved_by_article', label: 'Resolvido pela central de ajuda, sem chamado' },
    };
  }

  private outOfScope(i: Interpretation): Reply {
    this.rules.add(RULES.scope);
    this.state.pending = null;
    const area = i.outOfScopeArea ?? 'Outro';
    const name = area === 'Outro' ? 'outra área' : area;
    return {
      text: `Esse assunto é com ${name}, não com a TI, então não consigo resolver por aqui. ${OUT_OF_SCOPE_CHANNEL[area]} Se tiver algo de TI, estou à disposição.`,
      action: { code: 'redirect', label: `Redirecionou para ${name}` },
    };
  }

  private async clarify(i: Interpretation): Promise<Reply> {
    this.state.lowConfidenceStreak += 1;
    if (this.state.lowConfidenceStreak >= LOW_CONFIDENCE_STREAK_TO_HANDOFF) {
      this.reasoning = `${i.reasoning} É a ${this.state.lowConfidenceStreak}ª mensagem seguida que não entendo com segurança, então chamo um analista.`;
      return this.transfer('low_confidence');
    }
    this.state.pending = { kind: 'clarify' };
    return {
      text: 'Não tenho certeza se entendi. Você pode me contar com outras palavras o que precisa? Se preferir, escolha uma opção:',
      blocks: [
        {
          kind: 'options',
          question: null,
          options: [...START_OPTIONS.slice(0, 2), { label: 'Falar com um analista', action: { type: 'request_human' } }],
        },
      ],
      action: { code: 'clarify', label: 'Pediu esclarecimento (confiança baixa)' },
    };
  }

  private async answerFaq(i: Interpretation, text: string): Promise<Reply> {
    this.tracer.reveal('helpcenter.search');
    const article = (i.articleId ? getArticle(i.articleId) : undefined) ?? this.bestArticle(text);
    if (!article) {
      this.state.pending = null;
      return {
        text: 'Não encontrei nada sobre isso na central de ajuda. Se for um problema ou pedido, posso abrir um chamado; também posso chamar um analista.',
        blocks: [
          {
            kind: 'options',
            question: null,
            options: [
              { label: 'Tenho um problema', action: { type: 'start', topic: 'problem' } },
              { label: 'Falar com um analista', action: { type: 'request_human' } },
            ],
          },
        ],
        action: { code: 'faq_not_found', label: 'Não encontrou artigo' },
      };
    }
    this.facts['Artigo'] = `${article.id} — ${article.title}`;
    const applies = articleAppliesTo(article, this.user.os) && i.articleApplies !== false;
    const answer = i.answer ?? article.body;
    if (article.informational) {
      this.state.pending = null;
      this.resolved = true;
      return {
        text: answer,
        blocks: [{ kind: 'article', articleId: article.id, title: article.title }],
        action: { code: 'answer_faq', label: `Respondeu com o artigo ${article.id}` },
      };
    }
    if (!applies) {
      // O artigo não vale para o caso (ex.: Windows 11): segue para abrir chamado.
      this.state.slots = this.state.slots ?? emptySlots();
      this.mergeSlots(i, text);
      const s = this.slots();
      s.type = s.type ?? article.fallbackType;
      s.category = s.category ?? article.category;
      return this.continueIssue(i);
    }
    this.state.slots = this.state.slots ?? emptySlots();
    this.mergeSlots(i, text);
    const s = this.slots();
    s.type = s.type ?? article.fallbackType;
    s.category = s.category ?? article.category;
    s.articleChecked = true;
    this.state.pending = { kind: 'article', articleId: article.id };
    return {
      text: answer,
      blocks: [
        { kind: 'article', articleId: article.id, title: article.title },
        {
          kind: 'options',
          question: 'Isso resolveu?',
          options: [
            { label: 'Isso resolveu', action: { type: 'article_resolved' } },
            { label: 'Não resolveu', action: { type: 'article_not_resolved' } },
          ],
        },
      ],
      action: { code: 'suggest_article', label: `Sugeriu o artigo ${article.id} antes de abrir chamado` },
    };
  }

  private async ticketStatus(ref: string | null, i: Interpretation | null): Promise<Reply> {
    this.state.slots = null;
    if (ref) return this.showTicket(ref);
    this.tracer.reveal('tickets.list');
    if (this.ticketsDown) return this.ticketsUnavailable('consultar seus chamados');
    const open = this.openTickets;
    if (open.length === 0) {
      this.state.pending = null;
      const recent = this.allTickets.filter((t) => t.status === 'resolvido').slice(0, 2);
      return {
        text: `Você não tem chamados abertos no momento.${recent.length ? ` Os mais recentes já foram resolvidos: ${recent.map((t) => `${t.id} (${t.title})`).join(', ')}.` : ''} Posso ajudar com outra coisa?`,
        blocks: [{ kind: 'options', question: null, options: START_OPTIONS.filter((o) => o.action.type === 'start' && o.action.topic !== 'status') }],
        action: { code: 'no_open_tickets', label: 'Informou que não há chamados abertos' },
      };
    }
    // Se o funcionário citou o assunto, tenta achar o chamado sem pedir o número.
    const byCategory = i?.category ? open.filter((t) => t.category === i.category) : [];
    if (open.length === 1 || byCategory.length === 1) {
      const target = open.length === 1 ? open[0]! : byCategory[0]!;
      if (open.length > 1) this.reasoning += ` Pelo assunto (${i?.category}), só o ${target.id} corresponde.`;
      return this.showTicket(target.id);
    }
    this.state.pending = { kind: 'select_ticket', purpose: 'status', ticketIds: open.map((t) => t.id) };
    return {
      text: `Você tem ${open.length} chamados abertos. Sobre qual deles quer saber?`,
      blocks: [{ kind: 'ticket_selector', purpose: 'status', tickets: open.map((t) => toSummary(t, this.now)) }],
      action: { code: 'select_ticket', label: 'Pediu para escolher entre os chamados abertos' },
    };
  }

  private async showTicket(id: string): Promise<Reply> {
    let ticket: Ticket | null;
    try {
      ticket = await this.fetchTicket(id);
    } catch (err) {
      if (err instanceof TicketsUnavailableError) return this.ticketsUnavailable(`consultar o ${id}`);
      throw err;
    }
    if (!ticket) return this.privacyDenied(id);
    const view = toView(ticket, this.now);
    const sla = slaStatus(ticket, this.now);
    this.tracer.note('calculou o prazo', 'rules.sla', sla.dueAt ? `${sla.ruleLabel} → ${sla.overdue ? 'vencido' : `até ${formatDue(sla.dueAt, this.now)}`}` : 'chamado encerrado', {
      input: { priority: ticket.priority, updatedAt: ticket.updatedAt },
      output: sla,
    });
    this.rules.add(RULES.sla);
    this.state.focusTicketId = ticket.id;
    this.facts['Chamado'] = ticket.id;
    const card: Block = { kind: 'ticket_card', ticket: view };
    const prio = PRIORITY_LABEL[ticket.priority].toLowerCase();

    if (sla.overdue) {
      this.rules.add(RULES.handoff);
      this.state.pending = { kind: 'offer_human', ticketId: ticket.id };
      return {
        text: `Está sem atualização ${formatRelative(ticket.updatedAt, this.now)}, acima do prazo de ${sla.ruleLabel} para prioridade ${prio}. Quer que eu chame um analista?`,
        blocks: [
          card,
          {
            kind: 'options',
            question: null,
            options: [
              { label: 'Falar com um analista', action: { type: 'request_human' } },
              { label: 'Adicionar informação', action: { type: 'add_info', ticketId: ticket.id } },
              { label: 'Não, obrigado', action: { type: 'decline' } },
            ],
          },
        ],
        action: { code: 'show_ticket_overdue', label: `Mostrou o ${ticket.id} (vencido) e ofereceu um analista` },
      };
    }
    this.state.pending = null;
    if (!isOpenStatus(ticket.status)) {
      const canReopen = ticket.status === 'resolvido' && ticket.resolvedAt && daysSince(ticket.resolvedAt, this.now) <= 7;
      return {
        text: `O ${ticket.id} está ${STATUS_LABEL[ticket.status].toLowerCase()}${ticket.resolvedAt ? ` (${formatRelative(ticket.resolvedAt, this.now)})` : ''}.${canReopen ? ' Se o problema voltou, posso reabri-lo — é só me contar o que aconteceu.' : ''}`,
        blocks: [card],
        action: { code: 'show_ticket', label: `Mostrou o ${ticket.id}` },
      };
    }
    const last = view.lastEvent ? ` Última atualização ${formatRelative(view.lastEvent.at, this.now)}: “${truncate(view.lastEvent.text, 120)}”` : '';
    return {
      text: `O ${ticket.id} está ${STATUS_LABEL[ticket.status].toLowerCase()} e dentro do prazo.${last} A próxima resposta está prevista até ${formatDue(sla.dueAt!, this.now)}.`,
      blocks: [
        card,
        {
          kind: 'options',
          question: null,
          options: [
            { label: 'Adicionar informação', action: { type: 'add_info', ticketId: ticket.id } },
            { label: 'Não, obrigado', action: { type: 'decline' } },
          ],
        },
      ],
      action: { code: 'show_ticket', label: `Mostrou o ${ticket.id} com o prazo` },
    };
  }

  private async addInfo(ref: string | null, extra: string | null): Promise<Reply> {
    this.tracer.reveal('tickets.list');
    let targetId = ref ?? this.state.focusTicketId;
    if (!targetId) {
      if (this.ticketsDown) return this.ticketsUnavailable('consultar seus chamados');
      const open = this.openTickets;
      if (open.length === 0) {
        this.state.pending = null;
        return { text: 'Você não tem chamados abertos para complementar. Quer me contar o problema para eu abrir um?', action: { code: 'no_open_tickets', label: 'Nada para complementar' } };
      }
      if (open.length === 1) targetId = open[0]!.id;
      else {
        this.state.pending = { kind: 'select_ticket', purpose: 'add_info', ticketIds: open.map((t) => t.id) };
        return {
          text: 'Qual chamado você quer complementar?',
          blocks: [{ kind: 'ticket_selector', purpose: 'add_info', tickets: open.map((t) => toSummary(t, this.now)) }],
          action: { code: 'select_ticket', label: 'Pediu para escolher o chamado a complementar' },
        };
      }
    }
    let ticket: Ticket | null;
    try {
      ticket = await this.fetchTicket(targetId);
    } catch (err) {
      if (err instanceof TicketsUnavailableError) return this.ticketsUnavailable(`consultar o ${targetId}`);
      throw err;
    }
    if (!ticket) return this.privacyDenied(targetId);
    this.state.focusTicketId = ticket.id;
    if (extra) return this.buildUpdateDraft(ticket.id, extra);
    this.state.pending = { kind: 'await_info', ticketId: ticket.id };
    return {
      text: `O que você quer acrescentar ao ${ticket.id} (“${ticket.title}”)? Pode escrever com suas palavras — eu mostro como vai ficar antes de enviar.`,
      action: { code: 'ask_info', label: `Pediu a informação para o ${ticket.id}` },
    };
  }

  private async buildUpdateDraft(ticketId: string, comment: string): Promise<Reply> {
    let ticket: Ticket | null;
    try {
      ticket = await this.fetchTicket(ticketId);
    } catch (err) {
      if (err instanceof TicketsUnavailableError) return this.ticketsUnavailable(`consultar o ${ticketId}`);
      throw err;
    }
    if (!ticket) return this.privacyDenied(ticketId);
    const mode = isOpenStatus(ticket.status) ? 'update' : 'reopen';
    return this.composeDraft({ ticket, mode, comment }, mode === 'update' ? `Vou acrescentar isto ao ${ticket.id}. Confira:` : `Vou reabrir o ${ticket.id} com esta informação. Confira:`);
  }

  // ---- Abertura de chamado ------------------------------------------------

  private slots(): IssueSlots {
    if (!this.state.slots) this.state.slots = emptySlots();
    return this.state.slots;
  }

  private mergeSlots(i: Interpretation, text: string): void {
    const s = this.slots();
    if (text && !s.utterances.includes(text)) s.utterances.push(text);
    if (i.issueTitle) s.title = i.issueTitle;
    if (i.issueDescription) s.description = i.issueDescription;
    if (i.ticketType) s.type = s.type ?? i.ticketType;
    if (i.category) s.category = s.category ?? i.category;
    if (i.impact) s.impact = i.impact;
    if (i.blocked !== null) s.blocked = i.blocked;
    if (i.deadlineToday !== null) s.deadlineToday = i.deadlineToday;
    if (i.deadlineText) s.deadlineText = i.deadlineText;
    if (i.hasWorkaround !== null) s.hasWorkaround = i.hasWorkaround;
  }

  private async newIssue(i: Interpretation, text: string): Promise<Reply> {
    this.mergeSlots(i, text);
    return this.continueIssue(i);
  }

  /** Avança a abertura: duplicidade → central de ajuda → informações faltando → rascunho. */
  private async continueIssue(i: Interpretation | null): Promise<Reply> {
    const s = this.slots();
    const preface: string[] = [];

    if (!s.duplicateChecked) {
      s.duplicateChecked = true;
      this.tracer.reveal('tickets.list');
      if (this.ticketsDown) {
        preface.push('Não consegui consultar seus chamados agora (sistema instável), então não verifiquei duplicidade.');
      } else {
        const related = this.findRelated(i);
        if (related && isOpenStatus(related.status)) {
          this.rules.add(RULES.duplicate);
          this.reasoning += ` Já existe o ${related.id} aberto sobre o mesmo problema.`;
          return this.composeDraft(
            { ticket: related, mode: 'update', comment: s.description ?? s.utterances.join(' ') },
            `Você já tem o ${related.id} aberto sobre isso (“${related.title}”). Para não duplicar, vou acrescentar a nova informação a ele. Confira:`,
            true,
          );
        }
        if (related && related.status === 'resolvido') {
          this.rules.add(RULES.reopen);
          this.reasoning += ` O ${related.id} trata do mesmo problema e foi resolvido há menos de 7 dias.`;
          return this.composeDraft(
            { ticket: related, mode: 'reopen', comment: s.description ?? s.utterances.join(' ') },
            `O ${related.id} (“${related.title}”) foi resolvido ${formatRelative(related.resolvedAt!, this.now)}. Se é o mesmo problema, posso reabri-lo em vez de abrir outro. Confira:`,
            true,
          );
        }
        const subject = s.category && s.category !== 'Outros' ? s.category : 'esse assunto';
        preface.push(`Não há chamado aberto sobre ${subject}`);
      }
    }

    if (!s.articleChecked) {
      s.articleChecked = true;
      this.tracer.reveal('helpcenter.search');
      const article = this.articleFor(i);
      if (article && !article.informational) {
        this.facts['Artigo'] = `${article.id} — ${article.title}`;
        const applies = articleAppliesTo(article, this.user.os) && i?.articleApplies !== false;
        if (applies) {
          this.state.pending = { kind: 'article', articleId: article.id };
          return {
            text: `${preface.length ? `${preface.join('. ')}. ` : ''}Antes de abrir um chamado, tente isto da central de ajuda: ${article.body}`,
            blocks: [
              { kind: 'article', articleId: article.id, title: article.title },
              {
                kind: 'options',
                question: 'Isso resolveu?',
                options: [
                  { label: 'Isso resolveu', action: { type: 'article_resolved' } },
                  { label: 'Não resolveu, abrir chamado', action: { type: 'article_not_resolved' } },
                ],
              },
            ],
            action: { code: 'suggest_article', label: `Sugeriu o artigo ${article.id} antes de abrir chamado` },
          };
        }
        const condition = article.appliesToOs ? `vale só para ${article.appliesToOs.join(' e ')}` : 'não se aplica ao seu caso';
        const os = this.user.os ? ` — o seu é ${this.user.os}` : '';
        preface.push(`${preface.length ? 'e o' : 'O'} artigo “${article.title}” ${condition}${os}`);
        s.notes.push(`Artigo ${article.id} (${article.title}) consultado: ${condition}${os}.`);
      }
    }

    const intro = preface.length ? `${preface.join(', ')}. Vou abrir um chamado.` : '';

    if (s.utterances.join(' ').length < 12 && !s.category) {
      this.state.pending = { kind: 'ask_details' };
      return {
        text: `${intro ? `${intro} ` : ''}Pode me contar um pouco mais? O que exatamente não funciona, desde quando e em qual equipamento ou sistema?`,
        action: { code: 'ask_details', label: 'Pediu mais detalhes do problema' },
      };
    }
    if (!s.impact) {
      this.state.pending = { kind: 'ask_impact' };
      this.rules.add(RULES.required);
      return {
        text: intro || 'Para abrir o chamado, preciso de mais uma informação.',
        blocks: [{ kind: 'options', question: 'Quem está sendo afetado?', options: IMPACT_OPTIONS }],
        action: { code: 'ask_impact', label: 'Perguntou quem é afetado' },
      };
    }
    const manyAffected = s.impact === 'team' || s.impact === 'company';
    if (s.blocked === null && s.deadlineToday === null && s.hasWorkaround === null && !(manyAffected && (s.type ?? 'INC') === 'INC')) {
      this.state.pending = { kind: 'ask_urgency' };
      const isRequest = (s.type ?? 'INC') === 'REQ';
      return {
        text: intro || 'Entendi. Só mais uma pergunta para definir a prioridade.',
        blocks: [
          {
            kind: 'options',
            question: isRequest ? 'Para quando você precisa?' : 'Isso te impede de trabalhar ou há algum compromisso em risco hoje?',
            options: isRequest
              ? [
                  { label: 'Ainda hoje', action: { type: 'answer', field: 'urgency', value: 'deadline' } },
                  { label: 'Estou parado(a) sem isso', action: { type: 'answer', field: 'urgency', value: 'blocked' } },
                  { label: 'Sem urgência', action: { type: 'answer', field: 'urgency', value: 'none' } },
                ]
              : [
                  { label: 'Estou impedido(a) de trabalhar', action: { type: 'answer', field: 'urgency', value: 'blocked' } },
                  { label: 'Tenho um compromisso hoje', action: { type: 'answer', field: 'urgency', value: 'deadline' } },
                  { label: 'Atrapalha, mas consigo trabalhar', action: { type: 'answer', field: 'urgency', value: 'workaround' } },
                ],
          },
        ],
        action: { code: 'ask_urgency', label: 'Perguntou a urgência' },
      };
    }
    return this.composeDraft(null, null);
  }

  /**
   * Monta um rascunho. Sem `existing`, é um chamado novo a partir dos slots; com ele,
   * é atualização ou reabertura. Nada é gravado até o funcionário confirmar.
   */
  private composeDraft(
    existing: { ticket: Ticket; mode: 'update' | 'reopen'; comment: string } | null,
    lead: string | null,
    allowOpenNew = false,
  ): Reply {
    this.rules.add(RULES.draft);
    this.state.draftSeq += 1;
    const id = `D-${380 + this.state.draftSeq}`;
    let draft: Draft;
    let text: string;

    if (existing) {
      const { ticket, mode, comment } = existing;
      const due = computeDueAt(ticket.priority, this.now);
      draft = {
        id,
        mode,
        ticketId: ticket.id,
        type: ticket.type,
        title: ticket.title,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        affected: ticket.affected,
        comment: truncate(comment, 1500),
        priorityReason: 'mantida do chamado original',
        dueAt: due.toISOString(),
        slaLabel: SLA_RULES[ticket.priority].label,
      };
      text = lead ?? `Confira antes de eu ${mode === 'update' ? 'atualizar' : 'reabrir'} o ${ticket.id}:`;
      this.tracer.note('montou o rascunho', 'draft.compose', `${mode === 'update' ? 'Atualização' : 'Reabertura'} do ${ticket.id}`, { output: draft });
    } else {
      const s = this.slots();
      const type = s.type ?? 'INC';
      const category: Category = s.category ?? 'Outros';
      const impact: Impact = s.impact ?? 'unknown';
      const decision = classifyPriority({ type, impact, blocked: s.blocked, deadlineToday: s.deadlineToday, hasWorkaround: s.hasWorkaround });
      this.tracer.note('classificou a prioridade', 'rules.priority', `${PRIORITY_LABEL[decision.priority]}: ${decision.reason}`, {
        input: { type, impact, blocked: s.blocked, deadlineToday: s.deadlineToday, hasWorkaround: s.hasWorkaround },
        output: decision,
      });
      this.rules.add(decision.rule);
      const due = computeDueAt(decision.priority, this.now);
      this.reasoning = `${this.reasoning} Já tenho todos os dados obrigatórios; prioridade ${PRIORITY_LABEL[decision.priority].toLowerCase()} porque ${decision.reason} (prazo de ${SLA_RULES[decision.priority].label}). Mostro o rascunho e só crio depois da confirmação.`.trim();
      this.tracer.note('consultou o SLA', 'rules.sla', `${SLA_RULES[decision.priority].label} → resposta até ${formatDue(due.toISOString(), this.now)}`, {
        output: { dueAt: due.toISOString() },
      });
      this.rules.add(RULES.required);
      draft = {
        id,
        mode: 'create',
        ticketId: null,
        type,
        title: truncate(s.title ?? s.utterances[0] ?? 'Chamado aberto pelo Nexo Assist', 90),
        description: this.composeDescription(s),
        category,
        priority: decision.priority,
        affected: impact,
        comment: null,
        priorityReason: decision.reason,
        dueAt: due.toISOString(),
        slaLabel: SLA_RULES[decision.priority].label,
      };
      this.tracer.note('montou o rascunho', 'draft.compose', `${draft.type} · ${draft.category} · ${PRIORITY_LABEL[draft.priority]}`, { output: draft });
      const prio = PRIORITY_LABEL[decision.priority].toLowerCase();
      const dueText = formatDue(due.toISOString(), this.now);
      text =
        lead ??
        (decision.priority === 'critica'
          ? `Coloquei prioridade crítica porque ${decision.reason}. Assim que você confirmar, crio o chamado e já chamo um analista — o prazo é de 1 hora. Confira:`
          : `Coloquei prioridade ${prio} porque ${decision.reason} — a resposta chega até ${dueText}. Confira antes de eu criar:`);
    }

    // Um rascunho novo substitui o anterior que ainda estava pendente.
    if (this.state.draft && this.state.draft.id !== draft.id) {
      this.draftResolution = { draftId: this.state.draft.id, state: 'superseded', resultTicketId: null };
    }
    this.state.draft = draft;
    this.state.pending = { kind: 'confirm_draft', draftId: draft.id };
    this.facts['Rascunho'] = `${draft.id} (${draft.mode === 'create' ? 'novo chamado' : draft.mode === 'update' ? `atualizar ${draft.ticketId}` : `reabrir ${draft.ticketId}`})`;

    const blocks: Block[] = [{ kind: 'draft', draft, state: 'pending', resultTicketId: null }];
    if (allowOpenNew) {
      blocks.push({ kind: 'options', question: null, options: [{ label: 'É outro problema — abrir um novo', action: { type: 'open_new' } }] });
    }
    return {
      text,
      blocks,
      action: {
        code: `draft_${draft.mode}`,
        label: draft.mode === 'create' ? 'Montou o rascunho do chamado para confirmação' : draft.mode === 'update' ? `Propôs atualizar o ${draft.ticketId}` : `Propôs reabrir o ${draft.ticketId}`,
      },
    };
  }

  private composeDescription(s: IssueSlots): string {
    const parts = [s.description ?? s.utterances.join(' ')];
    const ctx: string[] = [];
    if (this.user.device) ctx.push(`Equipamento: ${this.user.device}${this.user.os ? ` (${this.user.os})` : ''}.`);
    if (s.deadlineText) ctx.push(`Compromisso em risco: ${s.deadlineText}.`);
    else if (s.deadlineToday) ctx.push('Há um compromisso hoje que depende disso.');
    if (s.blocked) ctx.push('A pessoa está impedida de trabalhar.');
    for (const n of s.notes) ctx.push(n);
    return truncate([...parts, ...ctx].join(' '), 1800);
  }

  private async confirmDraft(draftId: string, edits: DraftEdits | undefined): Promise<Reply> {
    const draft = this.state.draft;
    if (!draft || draft.id !== draftId) {
      return { text: 'Esse rascunho não está mais ativo. Se quiser, me conte de novo o que precisa.', action: { code: 'stale_draft', label: 'Rascunho expirado' } };
    }
    const final = applyEdits(draft, edits);
    if (edits && Object.keys(edits).length > 0) {
      this.facts['Editado pelo funcionário'] = Object.keys(edits).join(', ');
      if (edits.priority && edits.priority !== draft.priority) {
        final.priorityReason = 'ajustada pelo funcionário';
        final.dueAt = computeDueAt(final.priority, this.now).toISOString();
        final.slaLabel = SLA_RULES[final.priority].label;
      }
    }
    const key = `${this.input.conversationId}:${draft.id}`;
    const info: CallInfo = { attempts: 0 };
    let ticket: Ticket;
    try {
      if (final.mode === 'create') {
        ticket = await this.tracer.run(
          'criou o chamado',
          'tickets.create',
          () =>
            this.deps.tickets.create(
              {
                type: final.type,
                title: final.title,
                description: final.description,
                category: final.category,
                priority: final.priority,
                affected: final.affected,
                requesterEmail: this.user.email,
              },
              AGENT_NAME,
              key,
              info,
            ),
          { input: { draftId: draft.id, idempotencyKey: key }, summarize: (t) => ({ detail: `${t.id}${info.attempts > 1 ? ` · ${info.attempts} tentativas` : ''}`, output: { id: t.id } }) },
        );
      } else if (final.mode === 'update') {
        ticket = await this.tracer.run(
          `atualizou o ${final.ticketId}`,
          'tickets.comment',
          () => this.deps.tickets.comment(final.ticketId!, this.user.email, final.comment ?? '', AGENT_NAME, key, info),
          { input: { draftId: draft.id }, summarize: (t) => ({ detail: `${t.id}${info.attempts > 1 ? ` · ${info.attempts} tentativas` : ''}` }) },
        );
      } else {
        ticket = await this.tracer.run(
          `reabriu o ${final.ticketId}`,
          'tickets.reopen',
          () => this.deps.tickets.reopen(final.ticketId!, this.user.email, final.comment ?? 'Reaberto pelo funcionário.', AGENT_NAME, key, info),
          { input: { draftId: draft.id }, summarize: (t) => ({ detail: `${t.id}${info.attempts > 1 ? ` · ${info.attempts} tentativas` : ''}` }) },
        );
      }
    } catch (err) {
      if (err instanceof TicketsUnavailableError) {
        this.reasoning = 'O sistema de chamados não respondeu depois das retentativas; o rascunho continua pendente.';
        return {
          text: `O sistema de chamados está instável agora e não consegui registrar (tentei ${err.attempts} vezes). Nada foi perdido: o rascunho continua aqui — é só clicar em Confirmar de novo em alguns segundos.`,
          action: { code: 'tickets_unavailable', label: 'Sistema de chamados indisponível; rascunho mantido' },
        };
      }
      throw err;
    }

    this.draftResolution = { draftId: draft.id, state: 'confirmed', resultTicketId: ticket.id };
    this.state.draft = null;
    this.state.slots = null;
    this.state.pending = null;
    this.state.focusTicketId = ticket.id;
    this.facts['Chamado'] = ticket.id;
    const view = toView(ticket, this.now);
    const due = view.dueAt ? formatDue(view.dueAt, this.now) : null;

    if (final.mode === 'create' && ticket.priority === 'critica') {
      this.rules.add(RULES.handoff);
      const handoffReply = await this.transfer('critical', ticket);
      return {
        ...handoffReply,
        text: `Pronto: abri o ${ticket.id} com prioridade crítica. ${handoffReply.text}`,
        blocks: [{ kind: 'ticket_card', ticket: view }, ...(handoffReply.blocks ?? [])],
        action: { code: 'create_and_transfer', label: `Criou o ${ticket.id} (crítico) e chamou um analista` },
      };
    }
    const verb = final.mode === 'create' ? 'abri' : final.mode === 'update' ? 'atualizei' : 'reabri';
    return {
      text: `Pronto: ${verb} o ${ticket.id}${final.mode === 'create' ? ` com prioridade ${PRIORITY_LABEL[ticket.priority].toLowerCase()}` : ''}.${due ? ` Um analista responde até ${due} (${view.slaLabel}).` : ''} Você pode acompanhar por aqui a qualquer momento.`,
      blocks: [{ kind: 'ticket_card', ticket: view }],
      action: {
        code: `ticket_${final.mode}`,
        label: final.mode === 'create' ? `Criou o ${ticket.id}` : final.mode === 'update' ? `Atualizou o ${ticket.id}` : `Reabriu o ${ticket.id}`,
      },
    };
  }

  private cancelDraft(draftId: string): Reply {
    const draft = this.state.draft;
    if (!draft || draft.id !== draftId) {
      return { text: 'Esse rascunho já não está ativo.', action: { code: 'stale_draft', label: 'Rascunho expirado' } };
    }
    this.draftResolution = { draftId, state: 'cancelled', resultTicketId: null };
    this.state.draft = null;
    this.state.pending = null;
    const wasNew = draft.mode === 'create';
    if (wasNew) this.state.slots = null;
    return {
      text: wasNew
        ? 'Cancelado — nenhum chamado foi criado. Se quiser retomar, é só me contar de novo.'
        : `Cancelado — o ${draft.ticketId} não foi alterado.`,
      blocks: wasNew ? [] : [{ kind: 'options', question: null, options: [{ label: 'É outro problema — abrir um novo', action: { type: 'open_new' } }] }],
      action: { code: 'cancel_draft', label: `Cancelou o rascunho ${draftId}` },
    };
  }

  // ---- Transferência ------------------------------------------------------

  private async transfer(kind: HandoffKind, knownTicket?: Ticket): Promise<Reply> {
    this.rules.add(RULES.handoff);
    this.rules.add(RULES.paused);
    const team = teamFor(kind);
    let ticket: Ticket | null = knownTicket ?? null;
    const focus = this.state.focusTicketId;
    if (!ticket && focus) {
      try {
        ticket = await this.fetchTicket(focus);
      } catch {
        ticket = null;
      }
    }
    const summary = buildHandoffSummary({
      kind,
      user: this.user,
      state: this.state,
      ticket,
      history: [...this.input.history, { author: 'user', text: this.input.text }],
      lastIntent: this.intent,
      confidence: this.source === 'action' ? null : this.confidence,
      now: this.now,
    });
    if (ticket && isOpenStatus(ticket.status)) {
      try {
        const t = ticket;
        await this.tracer.run(`transferiu o ${t.id}`, 'tickets.transfer', () => this.deps.tickets.transfer(t.id, this.user.email, team, HANDOFF_REASON[kind], AGENT_NAME), {
          input: { team },
        });
      } catch {
        // A conversa é transferida mesmo se o sistema legado falhar; o analista vê o resumo.
      }
    }
    this.tracer.note('chamou um analista', 'handoff', `${team} · ${HANDOFF_REASON[kind]}`, { output: { team, kind } });
    this.handoff = {
      kind,
      reason: HANDOFF_REASON[kind],
      team,
      summary,
      confidence: kind === 'low_confidence' ? this.confidence : null,
      ticketId: ticket?.id ?? null,
      at: this.now.toISOString(),
    };
    this.state.pending = null;
    const eta =
      kind === 'critical'
        ? 'em até 1 hora (casos críticos têm plantão 24 h)'
        : isBusinessTime(this.now)
          ? 'em instantes, por aqui mesmo'
          : 'a partir das 8h do próximo dia útil (o service desk atende de segunda a sexta, das 8h às 18h)';
    const why =
      kind === 'low_confidence'
        ? 'Para não te dar uma resposta errada, '
        : kind === 'overdue'
          ? 'Como o chamado passou do prazo, '
          : '';
    return {
      text: `${why}${why ? 'encaminhei' : 'Encaminhei'} para o ${team}, com um resumo do caso. Um analista vai falar com você ${eta}. Enquanto isso eu fico em pausa — pode deixar mais detalhes aqui que ele vai ler.`,
      blocks: [{ kind: 'handoff', team, reason: HANDOFF_REASON[kind] }],
      action: { code: `handoff_${kind}`, label: `Transferiu para o ${team}` },
    };
  }

  // ---- Apoio --------------------------------------------------------------

  private async loadTickets(visible: boolean): Promise<void> {
    if (this.ticketsLoaded) return;
    this.ticketsLoaded = true;
    const info: CallInfo = { attempts: 0 };
    try {
      this.allTickets = await this.tracer.run('consultou seus chamados', 'tickets.list', () => this.deps.tickets.listMine(this.user.email, 'all', info), {
        visible,
        input: { requester: this.user.email },
        summarize: (list) => ({
          detail: `${list.filter((t) => isOpenStatus(t.status)).length} abertos, ${list.length} no total${info.attempts > 1 ? ` · ${info.attempts} tentativas` : ''}`,
          output: list.map((t) => `${t.id} · ${STATUS_LABEL[t.status]}`),
        }),
      });
    } catch (err) {
      if (!(err instanceof TicketsUnavailableError)) throw err;
      this.ticketsDown = true;
      this.allTickets = [];
    }
  }

  private async fetchTicket(id: string): Promise<Ticket | null> {
    const cached = this.allTickets.find((t) => t.id === id);
    if (cached) {
      this.tracer.reveal('tickets.list');
      this.tracer.note(`consultou o ${id}`, 'tickets.get', `${STATUS_LABEL[cached.status]} · ${PRIORITY_LABEL[cached.priority]}`);
      return cached;
    }
    const info: CallInfo = { attempts: 0 };
    return this.tracer.run(`consultou o ${id}`, 'tickets.get', () => this.deps.tickets.get(id, this.user.email, info), {
      input: { id },
      summarize: (t) => ({ detail: t ? `${STATUS_LABEL[t.status]} · ${PRIORITY_LABEL[t.priority]}` : 'não encontrado entre os chamados do funcionário' }),
    });
  }

  private isOverdue(ticketId: string): boolean {
    const t = this.allTickets.find((x) => x.id === ticketId);
    return t ? slaStatus(t, this.now).overdue : false;
  }

  private findRelated(i: Interpretation | null): Ticket | null {
    const pool = [...this.openTickets, ...this.recentlyResolved];
    if (i?.relatedTicketId) {
      const t = pool.find((x) => x.id === i.relatedTicketId);
      if (t) return t;
    }
    return null;
  }

  private articleFor(i: Interpretation | null): Article | null {
    if (i?.articleId) {
      const a = getArticle(i.articleId);
      if (a) return a;
    }
    return this.bestArticle(this.slots().utterances.join(' '));
  }

  private bestArticle(text: string): Article | null {
    const hit = searchArticles(text, 1)[0];
    return hit && hit.score >= STRONG_MATCH ? hit.article : null;
  }

  private privacyDenied(id: string): Reply {
    this.rules.add(RULES.privacy);
    this.state.pending = null;
    this.reasoning += ` O ${id} não está entre os chamados abertos por você.`;
    return {
      text: `Não encontrei o ${id} entre os seus chamados. Por privacidade, só posso passar informações de chamados abertos por você. Quer que eu mostre os seus?`,
      blocks: [{ kind: 'options', question: null, options: [{ label: 'Ver meus chamados', action: { type: 'start', topic: 'status' } }] }],
      action: { code: 'privacy_denied', label: 'Negou informação de chamado de outra pessoa' },
    };
  }

  private ticketsUnavailable(what: string): Reply {
    this.reasoning = `O sistema de chamados não respondeu depois das retentativas, então não foi possível ${what}.`;
    return {
      text: `O sistema de chamados está instável agora e não consegui ${what}. Pode tentar de novo em alguns segundos? Se for urgente, posso chamar um analista.`,
      blocks: [{ kind: 'options', question: null, options: [{ label: 'Falar com um analista', action: { type: 'request_human' } }] }],
      action: { code: 'tickets_unavailable', label: 'Sistema de chamados indisponível' },
    };
  }

  private staleAction(): Reply {
    this.state.pending = null;
    return { text: 'Essa opção não vale mais nesta conversa. Me conte o que você precisa agora?', action: { code: 'stale_action', label: 'Ignorou opção expirada' } };
  }

  private setUnderstanding(intent: Intent, understood: string, reasoning: string): void {
    this.intent = intent;
    this.understood = understood;
    this.reasoning = reasoning;
  }

  /** Nunca confia cegamente no LLM: referências precisam existir, valores precisam ser válidos. */
  private sanitize(i: Interpretation): Interpretation {
    const ids = new Set(this.allTickets.map((t) => t.id));
    const ref = i.ticketRef?.toUpperCase().replace(/\s/g, '').replace(/^(INC|REQ)(\d)/, '$1-$2') ?? null;
    return {
      ...i,
      ticketRef: ref && /^(INC|REQ)-\d{5}$/.test(ref) ? ref : null,
      relatedTicketId: i.relatedTicketId && ids.has(i.relatedTicketId) ? i.relatedTicketId : null,
      articleId: i.articleId && getArticle(i.articleId) ? i.articleId : null,
      confidence: Math.max(0, Math.min(1, i.confidence)),
    };
  }

  private collectFacts(i: Interpretation): void {
    this.facts['Intenção'] = INTENT_LABEL[i.intent];
    if (i.ticketType) this.facts['Tipo'] = i.ticketType === 'INC' ? 'Incidente (INC)' : 'Requisição (REQ)';
    if (i.category) this.facts['Categoria'] = i.category;
    if (i.impact) this.facts['Afetados'] = IMPACT_LABEL[i.impact];
    if (i.deadlineText) this.facts['Compromisso'] = i.deadlineText;
    else if (i.deadlineToday) this.facts['Compromisso'] = 'hoje';
    if (i.blocked) this.facts['Impedido de trabalhar'] = 'sim';
    if (i.ticketRef) this.facts['Chamado citado'] = i.ticketRef;
    if (i.relatedTicketId) this.facts['Chamado relacionado'] = i.relatedTicketId;
    if (i.outOfScopeArea) this.facts['Área'] = i.outOfScopeArea;
  }

  private finish(reply: Reply): TurnOutput {
    if (!this.understood) this.understood = 'Mensagem recebida.';
    const trace: DecisionTrace = {
      interpreter: this.source,
      model: this.model,
      intent: this.intent,
      understood: this.understood,
      facts: this.facts,
      action: reply.action,
      confidence: Math.round(this.confidence * 100) / 100,
      reasoning: this.reasoning.trim(),
      rules: [...this.rules],
      steps: this.tracer.steps,
      latencyMs: Math.round(performance.now() - this.started),
      usage: this.usage,
    };
    return {
      text: reply.text,
      blocks: reply.blocks ?? [],
      trace,
      state: this.state,
      handoff: this.handoff,
      resolved: this.resolved,
      draftResolution: this.draftResolution,
    };
  }
}

function applyEdits(draft: Draft, edits: DraftEdits | undefined): Draft {
  if (!edits) return { ...draft };
  const out = { ...draft };
  if (typeof edits.title === 'string' && edits.title.trim().length >= 5) out.title = truncate(edits.title, 120);
  if (typeof edits.description === 'string' && edits.description.trim().length >= 10) out.description = truncate(edits.description, 4000);
  if (typeof edits.comment === 'string' && edits.comment.trim().length >= 1) out.comment = truncate(edits.comment, 4000);
  if (edits.category && (CATEGORIES as readonly string[]).includes(edits.category)) out.category = edits.category;
  if (edits.priority && (PRIORITIES as readonly string[]).includes(edits.priority)) out.priority = edits.priority as Priority;
  if (edits.affected && (IMPACTS as readonly string[]).includes(edits.affected)) out.affected = edits.affected;
  return out;
}
