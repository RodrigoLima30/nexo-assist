import type { Category, TicketType } from '@shared/domain';

export interface Article {
  id: string;
  title: string;
  body: string;
  category: Category;
  /** Palavras que indicam o assunto (já sem acento). */
  keywords: string[];
  /** Restrições de aplicabilidade: o artigo só resolve para estes sistemas operacionais. */
  appliesToOs?: string[];
  /** Quando o artigo não se aplica ou não resolve, que tipo de chamado abrir. */
  fallbackType: TicketType;
  /** Artigo informativo (horário, política) — não é um passo de solução. */
  informational?: boolean;
}

/** Central de ajuda (Anexo B): artigos curtos, alguns com condições de uso. */
export const ARTICLES: readonly Article[] = [
  {
    id: 'KB-101',
    title: 'VPN com erro 809',
    body:
      'Reinstale o cliente de VPN pelo Portal de Softwares e reinicie o computador. Vale apenas para Windows 10; no Windows 11, abra um chamado.',
    category: 'Rede e VPN',
    keywords: ['vpn', '809', 'erro 809', 'conectar', 'conecta', 'forticlient'],
    appliesToOs: ['Windows 10'],
    fallbackType: 'INC',
  },
  {
    id: 'KB-102',
    title: 'Horário do service desk',
    body: 'De segunda a sexta, das 8h às 18h. Chamados críticos têm plantão 24 horas. Telefone: ramal 4000.',
    category: 'Outros',
    keywords: ['horario', 'atendimento', 'service desk', 'plantao', 'funciona', 'ramal', 'telefone', 'abre', 'fecha'],
    fallbackType: 'INC',
    informational: true,
  },
  {
    id: 'KB-103',
    title: 'Redefinir a senha da rede',
    body:
      'Acesse senha.nexo.com.br pelo celular ou por outro computador, confirme o código enviado por SMS e defina a nova senha. A nova senha vale para Windows, e-mail e VPN em até 15 minutos.',
    category: 'Acesso',
    keywords: ['senha', 'rede', 'expirou', 'expirada', 'esqueci', 'redefinir', 'trocar senha', 'windows', 'login'],
    fallbackType: 'INC',
  },
  {
    id: 'KB-104',
    title: 'Configurar o e-mail corporativo no celular',
    body:
      'Instale o Outlook pela loja do celular, entre com seu e-mail corporativo e aprove o acesso no Microsoft Authenticator. O celular precisa estar cadastrado no Intune (app Portal da Empresa).',
    category: 'E-mail',
    keywords: ['email', 'e-mail', 'outlook', 'celular', 'iphone', 'android', 'configurar', 'sincroniza'],
    fallbackType: 'INC',
  },
  {
    id: 'KB-105',
    title: 'Impressora não imprime',
    body:
      'Confira se a impressora tem papel e está online. No computador, abra Configurações › Impressoras, remova os documentos presos na fila e envie de novo. Se o painel mostrar erro, abra um chamado informando o andar.',
    category: 'Hardware',
    keywords: ['impressora', 'imprimir', 'imprime', 'impressao', 'fila', 'papel', 'toner'],
    fallbackType: 'INC',
  },
  {
    id: 'KB-106',
    title: 'Wi-Fi para visitantes',
    body:
      'Visitantes usam a rede Nexo-Convidados. A senha do dia aparece na recepção de cada andar e muda toda segunda-feira. Funcionários devem usar a rede Nexo-Corp com o login da rede.',
    category: 'Rede e VPN',
    keywords: ['wifi', 'wi-fi', 'visitante', 'convidado', 'convidados', 'senha do wifi', 'rede sem fio'],
    fallbackType: 'REQ',
    informational: true,
  },
  {
    id: 'KB-107',
    title: 'Instalar software',
    body:
      'Softwares homologados (Office, Teams, Zoom, Adobe Reader, 7-Zip, Power BI) são instalados pelo Portal de Softwares, sem chamado. Software fora da lista ou com licença paga precisa de uma requisição com aprovação da gestão.',
    category: 'Software',
    keywords: ['instalar', 'instalacao', 'software', 'programa', 'portal de softwares', 'licenca', 'power bi', 'zoom', 'adobe'],
    fallbackType: 'REQ',
  },
  {
    id: 'KB-108',
    title: 'Computador lento',
    body:
      'Reinicie o computador (não apenas bloqueie a tela), feche abas e programas que não estiver usando e rode o Diagnóstico Nexo pelo Portal de Softwares. Se continuar lento depois disso, abra um chamado.',
    category: 'Hardware',
    keywords: ['lento', 'lentidao', 'travando', 'trava', 'demora', 'devagar', 'performance', 'congela'],
    fallbackType: 'INC',
  },
];

export function getArticle(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}

/** O artigo se aplica ao equipamento da pessoa? (Ex.: VPN 809 só no Windows 10.) */
export function articleAppliesTo(article: Article, os: string | undefined): boolean {
  if (!article.appliesToOs || !os) return true;
  return article.appliesToOs.includes(os);
}
