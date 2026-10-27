import type {
  ChatMessage,
  ClientAction,
  ConsoleConversationResponse,
  ConsoleFilter,
  ConsoleListResponse,
  ConversationResponse,
  ConversationView,
  MeResponse,
  StreamEvent,
} from '@shared/chat';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua rede.', 0, 'network');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Erro ${res.status}`, res.status, data.code);
  return data as T;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<MeResponse>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  conversation: () => request<ConversationResponse>('GET', '/api/chat/conversation'),
  conversationById: (id: string) => request<ConversationResponse>('GET', `/api/chat/conversation/${id}`),
  newConversation: () => request<ConversationResponse>('POST', '/api/chat/conversation/new'),

  consoleList: (filter: ConsoleFilter, q: string) =>
    request<ConsoleListResponse>('GET', `/api/console/conversations?${new URLSearchParams({ filter, q })}`),
  consoleDetail: (id: string) => request<ConsoleConversationResponse>('GET', `/api/console/conversations/${id}`),
  assume: (id: string) => request<{ conversation: ConversationView }>('POST', `/api/console/conversations/${id}/assume`),
  release: (id: string) => request<{ conversation: ConversationView }>('POST', `/api/console/conversations/${id}/release`),
  close: (id: string) => request<{ conversation: ConversationView }>('POST', `/api/console/conversations/${id}/close`),
  reply: (id: string, text: string) => request<{ message: ChatMessage }>('POST', `/api/console/conversations/${id}/messages`, { text }),
};

/**
 * Envia uma mensagem e consome o stream SSE da resposta (passos do agent, texto em
 * pedaços, mensagem final). fetch + ReadableStream em vez de EventSource porque é POST.
 */
export async function sendMessage(
  body: { conversationId: string; text: string; action?: ClientAction },
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat/messages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua rede.', 0, 'network');
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(data.error ?? `Erro ${res.status}`, res.status, data.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
