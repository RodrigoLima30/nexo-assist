import type { Ticket } from '@shared/domain';
import type { TicketRepository } from './repository';

type SeedTicket = Omit<Ticket, 'events' | 'createdAt' | 'updatedAt' | 'resolvedAt'> & {
  createdDaysAgo: number;
  updatedDaysAgo: number;
  resolvedDaysAgo?: number;
  history: { daysAgo: number; kind: Ticket['events'][number]['kind']; text: string; author: string }[];
};

const ANA = 'ana.souza@nexo.com.br';

/**
 * Dados de exemplo do Anexo B. As datas são relativas ao momento do seed para que os
 * cenários (vencido, resolvido há 4 dias, em dia) continuem válidos em qualquer data.
 */
const SEED: SeedTicket[] = [
  {
    id: 'INC-20311',
    type: 'INC',
    title: 'Notebook lento após atualização do Windows',
    description:
      'Lentidão geral desde a última atualização do Windows. Reiniciar e rodar o diagnóstico da central não resolveu.',
    category: 'Hardware',
    priority: 'media',
    status: 'aguardando_analista',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 11,
    updatedDaysAgo: 6,
    history: [
      { daysAgo: 11, kind: 'created', text: 'Chamado aberto pelo formulário.', author: 'Ana Souza' },
      { daysAgo: 6, kind: 'status', text: 'Diagnóstico remoto sem falhas de disco. Aguardando analista N1.', author: 'Suporte N1' },
    ],
  },
  {
    id: 'INC-20298',
    type: 'INC',
    title: 'Acesso à pasta Financeiro no SharePoint',
    description: 'Sem permissão para abrir a pasta Financeiro/Fechamento no SharePoint desde a migração.',
    category: 'Acesso',
    priority: 'media',
    status: 'em_andamento',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 13,
    updatedDaysAgo: 1,
    history: [
      { daysAgo: 13, kind: 'created', text: 'Chamado aberto pelo formulário.', author: 'Ana Souza' },
      { daysAgo: 1, kind: 'status', text: 'Pedido de permissão enviado ao dono da pasta.', author: 'Suporte N1' },
    ],
  },
  {
    id: 'REQ-10442',
    type: 'REQ',
    title: 'Segundo monitor para home office',
    description: 'Monitor adicional de 24" para trabalho remoto. Aprovado pela gestora.',
    category: 'Hardware',
    priority: 'baixa',
    status: 'aprovado',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 18,
    updatedDaysAgo: 3,
    history: [
      { daysAgo: 18, kind: 'created', text: 'Requisição aberta pelo formulário.', author: 'Ana Souza' },
      { daysAgo: 3, kind: 'status', text: 'Aprovado pela gestão. Aguardando estoque.', author: 'Suporte N1' },
    ],
  },
  {
    id: 'INC-20150',
    type: 'INC',
    title: 'Senha do SAP bloqueada',
    description: 'Senha do SAP bloqueada após tentativas erradas.',
    category: 'Acesso',
    priority: 'media',
    status: 'resolvido',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 6,
    updatedDaysAgo: 4,
    resolvedDaysAgo: 4,
    history: [
      { daysAgo: 6, kind: 'created', text: 'Chamado aberto pelo formulário.', author: 'Ana Souza' },
      { daysAgo: 4, kind: 'status', text: 'Senha desbloqueada e redefinida.', author: 'Suporte N1' },
    ],
  },
  {
    id: 'INC-19877',
    type: 'INC',
    title: 'Outlook não sincroniza no celular',
    description: 'E-mails não chegam no Outlook do celular corporativo.',
    category: 'E-mail',
    priority: 'baixa',
    status: 'resolvido',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 58,
    updatedDaysAgo: 55,
    resolvedDaysAgo: 55,
    history: [{ daysAgo: 55, kind: 'status', text: 'Perfil reconfigurado no Intune.', author: 'Suporte N1' }],
  },
  {
    id: 'INC-19410',
    type: 'INC',
    title: 'Troca de senha da rede',
    description: 'Senha da rede expirada fora do escritório.',
    category: 'Acesso',
    priority: 'media',
    status: 'resolvido',
    requesterEmail: ANA,
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 110,
    updatedDaysAgo: 108,
    resolvedDaysAgo: 108,
    history: [{ daysAgo: 108, kind: 'status', text: 'Senha redefinida por telefone.', author: 'Suporte N1' }],
  },
  // ---- Outros funcionários (nunca podem aparecer para a Ana) ----
  {
    id: 'REQ-10447',
    type: 'REQ',
    title: 'Acesso ao SAP módulo FI',
    description: 'Preciso de acesso de consulta ao módulo FI do SAP para o fechamento de hoje.',
    category: 'Acesso',
    priority: 'alta',
    status: 'aguardando_analista',
    requesterEmail: 'carla.mendes@nexo.com.br',
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 0.1,
    updatedDaysAgo: 0.05,
    history: [{ daysAgo: 0.1, kind: 'created', text: 'Requisição aberta pelo Nexo Assist.', author: 'Nexo Assist' }],
  },
  {
    id: 'INC-20476',
    type: 'INC',
    title: 'Impressora do 2º andar não imprime',
    description: 'Fila de impressão travada na impressora do 2º andar (Logística).',
    category: 'Hardware',
    priority: 'media',
    status: 'em_andamento',
    requesterEmail: 'bruno.tavares@nexo.com.br',
    affected: 'team',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 2,
    updatedDaysAgo: 0.5,
    history: [{ daysAgo: 2, kind: 'created', text: 'Chamado aberto pelo formulário.', author: 'Bruno Tavares' }],
  },
  {
    id: 'INC-20519',
    type: 'INC',
    title: 'Teams sem áudio em reuniões',
    description: 'Ninguém escuta a Elisa nas reuniões do Teams; o microfone funciona em outros apps.',
    category: 'Software',
    priority: 'alta',
    status: 'novo',
    requesterEmail: 'elisa.prado@nexo.com.br',
    affected: 'self',
    assignedTeam: null,
    createdDaysAgo: 0.02,
    updatedDaysAgo: 0.02,
    history: [{ daysAgo: 0.02, kind: 'created', text: 'Chamado aberto pelo Nexo Assist.', author: 'Nexo Assist' }],
  },
  {
    id: 'INC-20488',
    type: 'INC',
    title: 'VPN cai a cada 10 minutos',
    description: 'Conexão da VPN cai com frequência no Wi-Fi de casa.',
    category: 'Rede e VPN',
    priority: 'media',
    status: 'resolvido',
    requesterEmail: 'fabio.nunes@nexo.com.br',
    affected: 'self',
    assignedTeam: 'Suporte N1',
    createdDaysAgo: 3,
    updatedDaysAgo: 1,
    resolvedDaysAgo: 1,
    history: [{ daysAgo: 1, kind: 'status', text: 'Cliente de VPN atualizado.', author: 'Suporte N1' }],
  },
];

export function seedTickets(repo: TicketRepository, now: Date = new Date()): number {
  if (repo.count() > 0) return 0;
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  for (const t of SEED) {
    const { createdDaysAgo, updatedDaysAgo, resolvedDaysAgo, history, ...rest } = t;
    repo.insertRaw({
      ...rest,
      createdAt: ago(createdDaysAgo),
      updatedAt: ago(updatedDaysAgo),
      resolvedAt: resolvedDaysAgo === undefined ? null : ago(resolvedDaysAgo),
    });
    for (const h of history) repo.addEvent(t.id, h.kind, h.text, h.author, ago(h.daysAgo));
  }
  return SEED.length;
}
