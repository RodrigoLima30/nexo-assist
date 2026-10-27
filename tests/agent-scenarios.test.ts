import { describe, expect, it } from 'vitest';
import type { Block, ClientAction, Handoff } from '@shared/chat';
import { AgentEngine, type TurnOutput } from '../server/agent/engine';
import { OfflineInterpreter } from '../server/agent/interpreter/offline';
import { initialState, type AgentState } from '../server/agent/state';
import { requirePerson } from '../server/directory/people';
import { makeTicketsStack } from './helpers';

// Terça, 27/10/2026, 10:00 em Brasília — horário comercial.
const NOW = new Date('2026-10-27T10:00:00-03:00');

/** Simula uma conversa: guarda estado e histórico como a API faz. */
function chat(email = 'ana.souza@nexo.com.br', stackOpts: Parameters<typeof makeTicketsStack>[0] = {}) {
  const stack = makeTicketsStack({ now: NOW, ...stackOpts });
  const engine = new AgentEngine({ tickets: stack.client, interpreter: new OfflineInterpreter(), now: () => NOW });
  const user = requirePerson(email);
  let state: AgentState = initialState();
  const history: { author: string; text: string }[] = [];
  let handoff: Handoff | null = null;

  async function turn(text: string, action: ClientAction | null = null): Promise<TurnOutput> {
    const out = await engine.handle({ conversationId: 'c-test', user, state, text, action, history: [...history] });
    history.push({ author: 'user', text }, { author: 'agent', text: out.text });
    state = out.state;
    handoff = out.handoff ?? handoff;
    return out;
  }
  return {
    stack,
    say: (text: string) => turn(text),
    click: (label: string, action: ClientAction) => turn(label, action),
    get state() {
      return state;
    },
    get handoff() {
      return handoff;
    },
  };
}

function block<K extends Block['kind']>(out: TurnOutput, kind: K): Extract<Block, { kind: K }> {
  const b = out.blocks.find((x) => x.kind === kind);
  if (!b) throw new Error(`Bloco ${kind} ausente. Texto: ${out.text}`);
  return b as Extract<Block, { kind: K }>;
}

const visibleLabels = (out: TurnOutput) => out.trace.steps.filter((s) => s.visible).map((s) => s.label);

describe('abrir chamado conversando (Tela 2)', () => {
  it('VPN 809 no Windows 11: pergunta o impacto, classifica alta pela reunião e só cria após confirmar', async () => {
    const c = chat();
    const r1 = await c.say('Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.');
    expect(r1.trace.intent).toBe('report_issue');
    expect(r1.text).toContain('Windows 10');
    expect(r1.text).toContain('Windows 11');
    expect(block(r1, 'options').question).toBe('Quem está sendo afetado?');
    expect(visibleLabels(r1)).toEqual(expect.arrayContaining(['consultou seus chamados', 'buscou na central de ajuda']));

    const r2 = await c.say('Só eu. Tenho reunião com um cliente às 14h e preciso da VPN funcionando.');
    const draft = block(r2, 'draft').draft;
    expect(draft).toMatchObject({ mode: 'create', type: 'INC', category: 'Rede e VPN', priority: 'alta', affected: 'self' });
    expect(new Date(draft.dueAt)).toEqual(new Date('2026-10-27T14:00:00-03:00'));
    expect(draft.description).toContain('Windows 11');
    expect(visibleLabels(r2)).toEqual(['classificou a prioridade', 'consultou o SLA', 'montou o rascunho']);
    expect(r2.trace.rules.some((r) => r.startsWith('Alta'))).toBe(true);

    // Nada foi criado ainda.
    expect((await c.stack.client.listMine('ana.souza@nexo.com.br', 'open')).length).toBe(3);

    const r3 = await c.click('Confirmar', { type: 'confirm_draft', draftId: draft.id });
    const card = block(r3, 'ticket_card').ticket;
    expect(card.id).toMatch(/^INC-\d{5}$/);
    expect(r3.draftResolution).toMatchObject({ draftId: draft.id, state: 'confirmed', resultTicketId: card.id });
    expect((await c.stack.client.listMine('ana.souza@nexo.com.br', 'open')).length).toBe(4);

    // Clicar de novo não duplica.
    const r4 = await c.click('Confirmar', { type: 'confirm_draft', draftId: draft.id });
    expect(r4.trace.action.code).toBe('stale_draft');
    expect((await c.stack.client.listMine('ana.souza@nexo.com.br', 'open')).length).toBe(4);
  });

  it('caso crítico (equipe parada) cria e transfere direto para o N2', async () => {
    const c = chat();
    const r1 = await c.say('A internet caiu para toda a equipe, ninguém consegue trabalhar.');
    const draft = block(r1, 'draft').draft;
    expect(draft.priority).toBe('critica');
    const r2 = await c.click('Confirmar', { type: 'confirm_draft', draftId: draft.id });
    expect(r2.handoff).toMatchObject({ kind: 'critical', team: 'Suporte N2' });
    expect(r2.handoff?.summary).toContain('Ana Souza');
  });

  it('sugere o artigo quando ele se aplica (Windows 10) e segue para o chamado se não resolver', async () => {
    const c = chat('carla.mendes@nexo.com.br');
    const r1 = await c.say('Minha VPN não conecta, dá erro 809');
    expect(r1.trace.action.code).toBe('suggest_article');
    expect(block(r1, 'article').articleId).toBe('KB-101');
    const r2 = await c.click('Não resolveu, abrir chamado', { type: 'article_not_resolved' });
    expect(block(r2, 'options').question).toBe('Quem está sendo afetado?');
  });

  it('cancelar o rascunho não cria nada', async () => {
    const c = chat();
    await c.say('O Excel fecha sozinho quando abro planilhas grandes, mas consigo usar o Google Sheets.');
    const r = await c.click('Só eu', { type: 'answer', field: 'impact', value: 'self' });
    const draft = block(r, 'draft').draft;
    expect(draft.priority).toBe('media');
    const r2 = await c.click('Cancelar', { type: 'cancel_draft', draftId: draft.id });
    expect(r2.draftResolution?.state).toBe('cancelled');
    expect((await c.stack.client.listMine('ana.souza@nexo.com.br', 'open')).length).toBe(3);
  });
});

describe('sem duplicidade', () => {
  it('problema igual a um chamado aberto vira atualização do existente', async () => {
    const c = chat();
    const r = await c.say('Meu notebook continua muito lento, agora trava ao abrir o Excel.');
    const draft = block(r, 'draft').draft;
    expect(draft).toMatchObject({ mode: 'update', ticketId: 'INC-20311' });
    expect(r.trace.rules.some((x) => x.startsWith('Sem duplicidade'))).toBe(true);
    const r2 = await c.click('Confirmar', { type: 'confirm_draft', draftId: draft.id });
    expect(r2.trace.action.code).toBe('ticket_update');
  });

  it('assunto novo depois de cancelar uma atualização ainda checa duplicidade', async () => {
    const c = chat();
    const r1 = await c.say('Meu notebook continua muito lento, agora trava ao abrir o Excel.');
    await c.click('Cancelar', { type: 'cancel_draft', draftId: block(r1, 'draft').draft.id });
    const r2 = await c.say('A senha do SAP está bloqueada de novo.');
    expect(block(r2, 'draft').draft).toMatchObject({ mode: 'reopen', ticketId: 'INC-20150' });
  });

  it('problema de um chamado resolvido há 4 dias propõe reabrir', async () => {
    const c = chat();
    const r = await c.say('A senha do SAP está bloqueada de novo.');
    expect(block(r, 'draft').draft).toMatchObject({ mode: 'reopen', ticketId: 'INC-20150' });
    const r2 = await c.click('Confirmar', { type: 'confirm_draft', draftId: block(r, 'draft').draft.id });
    expect(r2.trace.action.code).toBe('ticket_reopen');
  });
});

describe('consulta de chamado (Tela 3)', () => {
  it('lista para escolher, mostra prazo vencido e transfere quando pedido', async () => {
    const c = chat();
    const r1 = await c.say('Qual o status do meu chamado?');
    const selector = block(r1, 'ticket_selector');
    expect(selector.tickets.map((t) => t.id).sort()).toEqual(['INC-20298', 'INC-20311', 'REQ-10442']);

    const r2 = await c.click('INC-20311 · Notebook lento', { type: 'select_ticket', ticketId: 'INC-20311', purpose: 'status' });
    const card = block(r2, 'ticket_card').ticket;
    expect(card.overdue).toBe(true);
    expect(r2.text).toContain('3 dias úteis');
    expect(block(r2, 'options').options.map((o) => o.label)).toContain('Falar com um analista');

    const r3 = await c.say('Quero falar com um analista.');
    expect(r3.handoff).toMatchObject({ kind: 'overdue', team: 'Suporte N2', ticketId: 'INC-20311' });
    const t = await c.stack.client.get('INC-20311', 'ana.souza@nexo.com.br');
    expect(t?.events.at(-1)?.kind).toBe('transfer');
  });

  it('acha o chamado pelo assunto, sem o número', async () => {
    const c = chat();
    const r = await c.say('Como está o meu pedido do monitor?');
    expect(block(r, 'ticket_card').ticket.id).toBe('REQ-10442');
  });

  it('não revela chamado de outra pessoa', async () => {
    const c = chat();
    const r = await c.say('Como está o REQ-10447?');
    expect(r.trace.action.code).toBe('privacy_denied');
    expect(r.text).not.toContain('SAP');
    expect(r.blocks.some((b) => b.kind === 'ticket_card')).toBe(false);
  });

  it('avisa quando o sistema de chamados está fora, sem inventar dados', async () => {
    const c = chat('ana.souza@nexo.com.br', { failureRate: 1 });
    const r = await c.say('Qual o status do meu chamado?');
    expect(r.trace.action.code).toBe('tickets_unavailable');
    expect(r.trace.steps.some((s) => s.status === 'error')).toBe(true);
  });
});

describe('complementar chamado', () => {
  it('pede a informação e monta o rascunho de atualização', async () => {
    const c = chat();
    const r1 = await c.say('Quero adicionar uma informação ao INC-20298');
    expect(r1.trace.action.code).toBe('ask_info');
    const r2 = await c.say('A pasta que preciso é Financeiro/Fechamento/2026.');
    expect(block(r2, 'draft').draft).toMatchObject({ mode: 'update', ticketId: 'INC-20298' });
  });
});

describe('dúvidas, escopo e segurança', () => {
  it('responde dúvida pela central de ajuda sem abrir chamado', async () => {
    const c = chat();
    const r = await c.say('Qual o horário de atendimento do service desk?');
    expect(r.trace.intent).toBe('faq');
    expect(r.text).toContain('8h às 18h');
    expect(r.resolved).toBe(true);
  });

  it('redireciona assunto de RH', async () => {
    const c = chat();
    const r = await c.say('Como faço para marcar minhas férias?');
    expect(r.trace.intent).toBe('out_of_scope');
    expect(r.text).toContain('RH');
  });

  it('pergunta quando não entende e chama um analista na segunda vez', async () => {
    const c = chat();
    const r1 = await c.say('blá blá xyz');
    expect(r1.trace.action.code).toBe('clarify');
    expect(r1.handoff).toBeNull();
    const r2 = await c.say('hmm talvez aquilo lá');
    expect(r2.handoff).toMatchObject({ kind: 'low_confidence' });
    expect(r2.handoff?.confidence).toBeLessThan(0.5);
  });

  it('transfere imediatamente quando o funcionário pede', async () => {
    const c = chat();
    const r = await c.say('Prefiro falar com um atendente humano');
    expect(r.handoff).toMatchObject({ kind: 'user_request', team: 'Suporte N1' });
  });

  it('toda resposta tem trilha de decisão completa', async () => {
    const c = chat();
    const r = await c.say('Oi');
    expect(r.trace).toMatchObject({ interpreter: 'offline', intent: 'greeting' });
    expect(r.trace.understood.length).toBeGreaterThan(0);
    expect(r.trace.action.label.length).toBeGreaterThan(0);
    expect(r.trace.confidence).toBeGreaterThan(0.9);
  });
});
