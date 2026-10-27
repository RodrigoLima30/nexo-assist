import type { NewTicketInput, Ticket, TicketStatus } from '@shared/domain';

/**
 * Cliente do serviço de chamados. O sistema é legado e fica indisponível por alguns
 * segundos de vez em quando, então toda chamada tem timeout e retentativa com backoff
 * exponencial para erros transitórios (503, falha de rede, timeout). Erros 4xx não são
 * repetidos. Escritas levam uma Idempotency-Key, então repetir nunca duplica um chamado.
 */

export class TicketsUnavailableError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'TicketsUnavailableError';
  }
}

export class TicketsRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'TicketsRequestError';
  }
}

/** Preenchido pelo cliente para que a trilha de decisão mostre as retentativas. */
export interface CallInfo {
  attempts: number;
}

export interface TicketsClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Method = 'GET' | 'POST';

export class TicketsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TicketsClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.backoffMs = opts.backoffMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async listMine(requesterEmail: string, scope: 'open' | 'all', info?: CallInfo): Promise<Ticket[]> {
    const q = new URLSearchParams({ requester: requesterEmail, scope });
    const res = await this.request<{ tickets: Ticket[] }>('GET', `/tickets?${q}`, undefined, undefined, info);
    return res.tickets;
  }

  /** Devolve null quando o chamado não existe ou não pertence ao solicitante. */
  async get(id: string, requesterEmail: string, info?: CallInfo): Promise<Ticket | null> {
    const q = new URLSearchParams({ requester: requesterEmail });
    try {
      const res = await this.request<{ ticket: Ticket }>('GET', `/tickets/${encodeURIComponent(id)}?${q}`, undefined, undefined, info);
      return res.ticket;
    } catch (err) {
      if (err instanceof TicketsRequestError && err.status === 404) return null;
      throw err;
    }
  }

  async create(input: NewTicketInput, author: string, idempotencyKey: string, info?: CallInfo): Promise<Ticket> {
    const res = await this.request<{ ticket: Ticket }>('POST', '/tickets', { ...input, author }, idempotencyKey, info);
    return res.ticket;
  }

  async comment(id: string, requesterEmail: string, text: string, author: string, idempotencyKey: string, info?: CallInfo): Promise<Ticket> {
    const res = await this.request<{ ticket: Ticket }>(
      'POST',
      `/tickets/${encodeURIComponent(id)}/comments`,
      { requesterEmail, text, author },
      idempotencyKey,
      info,
    );
    return res.ticket;
  }

  async reopen(id: string, requesterEmail: string, text: string, author: string, idempotencyKey: string, info?: CallInfo): Promise<Ticket> {
    const res = await this.request<{ ticket: Ticket }>(
      'POST',
      `/tickets/${encodeURIComponent(id)}/reopen`,
      { requesterEmail, text, author },
      idempotencyKey,
      info,
    );
    return res.ticket;
  }

  async transfer(id: string, requesterEmail: string, team: string, summary: string, author: string, info?: CallInfo): Promise<Ticket> {
    const res = await this.request<{ ticket: Ticket }>(
      'POST',
      `/tickets/${encodeURIComponent(id)}/transfer`,
      { requesterEmail, team, summary, author },
      undefined,
      info,
    );
    return res.ticket;
  }

  async setStatus(id: string, requesterEmail: string, status: TicketStatus, note: string, author: string, info?: CallInfo): Promise<Ticket> {
    const res = await this.request<{ ticket: Ticket }>(
      'POST',
      `/tickets/${encodeURIComponent(id)}/status`,
      { requesterEmail, status, note, author },
      undefined,
      info,
    );
    return res.ticket;
  }

  private async request<T>(method: Method, path: string, body?: unknown, idempotencyKey?: string, info?: CallInfo): Promise<T> {
    let lastError = 'erro desconhecido';
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      if (info) info.attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) return (await res.json()) as T;
        const payload = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (res.status >= 500) {
          lastError = payload.error ?? `HTTP ${res.status}`;
        } else {
          throw new TicketsRequestError(payload.error ?? `HTTP ${res.status}`, res.status, payload.code);
        }
      } catch (err) {
        if (err instanceof TicketsRequestError) throw err;
        lastError = err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.retries) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
    }
    throw new TicketsUnavailableError(`Serviço de chamados indisponível (${lastError})`, this.retries);
  }
}
