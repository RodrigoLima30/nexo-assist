import type { DatabaseSync } from 'node:sqlite';
import type { ClientAction } from '@shared/chat';
import type { AgentEngine } from '../agent/engine';
import type { TicketsClient } from '../clients/tickets-client';
import { requirePerson } from '../directory/people';
import { ConversationService } from './conversations';
import { Store } from './store';

interface ScriptStep {
  text: string;
  action?: ClientAction;
}

/**
 * Conversas de exemplo para o console do analista. Em vez de inventar mensagens, elas
 * são geradas rodando o próprio agent, então as trilhas de decisão são reais.
 * A Ana fica sem conversa, para quem for testar começar do zero.
 */
const SCRIPTS: { email: string; minutesAgo: number; steps: ScriptStep[] }[] = [
  {
    email: 'gabriela.rocha@nexo.com.br',
    minutesAgo: 60 * 20,
    steps: [{ text: 'Qual a senha do wi-fi para visitantes?' }, { text: 'Obrigada!' }],
  },
  {
    email: 'fabio.nunes@nexo.com.br',
    minutesAgo: 70,
    steps: [{ text: 'Qual o horário de atendimento do service desk?' }, { text: 'Isso resolveu, obrigado!' }],
  },
  {
    email: 'bruno.tavares@nexo.com.br',
    minutesAgo: 25,
    steps: [{ text: 'o negócio lá não tá indo' }, { text: 'sabe aquilo do sistema de novo' }],
  },
  {
    email: 'carla.mendes@nexo.com.br',
    minutesAgo: 12,
    steps: [{ text: 'Qual o status do meu chamado?' }, { text: 'Preciso disso ainda hoje, quero falar com um analista.' }],
  },
  {
    email: 'elisa.prado@nexo.com.br',
    minutesAgo: 4,
    steps: [{ text: 'Oi' }],
  },
];

export async function seedConversations(db: DatabaseSync, engine: AgentEngine, tickets: TicketsClient, maxUserMessages: number): Promise<number> {
  let clock = Date.now();
  const store = new Store(db, () => new Date(clock));
  if (store.countConversations() > 0) return 0;
  const service = new ConversationService(store, engine, tickets, { maxUserMessages, streamDelayMs: 0 });
  for (const script of SCRIPTS) {
    clock = Date.now() - script.minutesAgo * 60_000;
    const user = requirePerson(script.email);
    const { conversation } = service.current(user);
    for (const step of script.steps) {
      clock += 45_000;
      await service.send(user, conversation.id, step.text, step.action ?? null, async () => {});
    }
  }
  return SCRIPTS.length;
}
