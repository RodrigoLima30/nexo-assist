import type { DatabaseSync } from 'node:sqlite';
import type {
  Category,
  Impact,
  NewTicketInput,
  Priority,
  Ticket,
  TicketEvent,
  TicketEventKind,
  TicketStatus,
  TicketType,
} from '@shared/domain';
import { isOpenStatus } from '@shared/domain';
import { transaction } from '../lib/sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  affected TEXT NOT NULL,
  assigned_team TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_email);
CREATE TABLE IF NOT EXISTS ticket_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);
CREATE TABLE IF NOT EXISTS sequences (type TEXT PRIMARY KEY, next INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, created_at TEXT NOT NULL);
`;

/** Chamados resolvidos há até 7 dias podem ser reabertos (Anexo A). */
export const REOPEN_WINDOW_DAYS = 7;

export class TicketError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

interface TicketRow {
  id: string;
  type: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  requester_email: string;
  affected: string;
  assigned_team: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface EventRow {
  at: string;
  kind: string;
  text: string;
  author: string;
}

export class TicketRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO sequences(type, next) VALUES ('INC', 20520), ('REQ', 10450)").run();
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
    return row.n;
  }

  /** Lista os chamados de um solicitante. Nunca devolve chamados de outra pessoa. */
  listByRequester(email: string, scope: 'open' | 'all'): Ticket[] {
    const rows = this.db
      .prepare('SELECT * FROM tickets WHERE requester_email = ? ORDER BY updated_at DESC')
      .all(email.toLowerCase()) as unknown as TicketRow[];
    return rows.map((r) => this.hydrate(r)).filter((t) => scope === 'all' || isOpenStatus(t.status));
  }

  /** Busca um chamado do solicitante. Chamado de outra pessoa é tratado como inexistente. */
  getForRequester(id: string, email: string): Ticket {
    const row = this.db
      .prepare('SELECT * FROM tickets WHERE id = ? AND requester_email = ?')
      .get(id.toUpperCase(), email.toLowerCase()) as TicketRow | undefined;
    if (!row) throw new TicketError('not_found', `Chamado ${id} não encontrado para este solicitante.`);
    return this.hydrate(row);
  }

  create(input: NewTicketInput, author: string, idempotencyKey: string | null): { ticket: Ticket; replayed: boolean } {
    return transaction(this.db, () => {
      if (idempotencyKey) {
        const prior = this.db.prepare('SELECT ticket_id FROM idempotency WHERE key = ?').get(idempotencyKey) as
          | { ticket_id: string }
          | undefined;
        if (prior) return { ticket: this.getForRequester(prior.ticket_id, input.requesterEmail), replayed: true };
      }
      const seq = this.db.prepare('SELECT next FROM sequences WHERE type = ?').get(input.type) as { next: number };
      this.db.prepare('UPDATE sequences SET next = next + 1 WHERE type = ?').run(input.type);
      const id = `${input.type}-${seq.next}`;
      const now = this.clock().toISOString();
      this.insertRaw({
        id,
        type: input.type,
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        status: 'novo',
        requesterEmail: input.requesterEmail.toLowerCase(),
        affected: input.affected,
        assignedTeam: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      });
      this.addEvent(id, 'created', 'Chamado aberto pelo Nexo Assist.', author, now);
      if (idempotencyKey) {
        this.db.prepare('INSERT INTO idempotency(key, ticket_id, created_at) VALUES (?, ?, ?)').run(idempotencyKey, id, now);
      }
      return { ticket: this.getForRequester(id, input.requesterEmail), replayed: false };
    });
  }

  addComment(id: string, email: string, text: string, author: string, idempotencyKey: string | null): Ticket {
    return transaction(this.db, () => {
      if (idempotencyKey && this.seenKey(idempotencyKey)) return this.getForRequester(id, email);
      const ticket = this.getForRequester(id, email);
      if (!isOpenStatus(ticket.status)) {
        throw new TicketError('conflict', `O chamado ${id} está ${ticket.status}; reabra antes de atualizar.`);
      }
      const now = this.clock().toISOString();
      const nextStatus: TicketStatus = ticket.status === 'aguardando_usuario' ? 'aguardando_analista' : ticket.status;
      this.db.prepare('UPDATE tickets SET updated_at = ?, status = ? WHERE id = ?').run(now, nextStatus, ticket.id);
      this.addEvent(ticket.id, 'comment', text, author, now);
      this.rememberKey(idempotencyKey, ticket.id, now);
      return this.getForRequester(id, email);
    });
  }

  reopen(id: string, email: string, text: string, author: string, idempotencyKey: string | null): Ticket {
    return transaction(this.db, () => {
      if (idempotencyKey && this.seenKey(idempotencyKey)) return this.getForRequester(id, email);
      const ticket = this.getForRequester(id, email);
      if (ticket.status !== 'resolvido' || !ticket.resolvedAt) {
        throw new TicketError('conflict', `Só é possível reabrir chamados resolvidos; ${id} está ${ticket.status}.`);
      }
      const ageDays = (this.clock().getTime() - new Date(ticket.resolvedAt).getTime()) / 86_400_000;
      if (ageDays > REOPEN_WINDOW_DAYS) {
        throw new TicketError('conflict', `O chamado ${id} foi resolvido há mais de ${REOPEN_WINDOW_DAYS} dias.`);
      }
      const now = this.clock().toISOString();
      this.db
        .prepare("UPDATE tickets SET status = 'aguardando_analista', resolved_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, ticket.id);
      this.addEvent(ticket.id, 'reopened', text, author, now);
      this.rememberKey(idempotencyKey, ticket.id, now);
      return this.getForRequester(id, email);
    });
  }

  transfer(id: string, email: string, team: string, summary: string, author: string): Ticket {
    return transaction(this.db, () => {
      const ticket = this.getForRequester(id, email);
      const now = this.clock().toISOString();
      const status: TicketStatus = isOpenStatus(ticket.status) ? 'aguardando_analista' : ticket.status;
      this.db
        .prepare('UPDATE tickets SET assigned_team = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(team, status, now, ticket.id);
      this.addEvent(ticket.id, 'transfer', `Transferido para ${team}. ${summary}`, author, now);
      return this.getForRequester(id, email);
    });
  }

  setStatus(id: string, email: string, status: TicketStatus, author: string, note: string): Ticket {
    return transaction(this.db, () => {
      const ticket = this.getForRequester(id, email);
      const now = this.clock().toISOString();
      const resolvedAt = status === 'resolvido' ? now : null;
      this.db
        .prepare('UPDATE tickets SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
        .run(status, resolvedAt, now, ticket.id);
      this.addEvent(ticket.id, 'status', note, author, now);
      return this.getForRequester(id, email);
    });
  }

  /** Inserção direta, usada pelo seed. */
  insertRaw(t: Omit<Ticket, 'events'>): void {
    this.db
      .prepare(
        `INSERT INTO tickets(id, type, title, description, category, priority, status, requester_email, affected,
          assigned_team, created_at, updated_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id,
        t.type,
        t.title,
        t.description,
        t.category,
        t.priority,
        t.status,
        t.requesterEmail.toLowerCase(),
        t.affected,
        t.assignedTeam,
        t.createdAt,
        t.updatedAt,
        t.resolvedAt,
      );
  }

  addEvent(ticketId: string, kind: TicketEventKind, text: string, author: string, at: string): void {
    this.db
      .prepare('INSERT INTO ticket_events(ticket_id, at, kind, text, author) VALUES (?,?,?,?,?)')
      .run(ticketId, at, kind, text, author);
  }

  private seenKey(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM idempotency WHERE key = ?').get(key));
  }

  private rememberKey(key: string | null, ticketId: string, at: string): void {
    if (key) this.db.prepare('INSERT INTO idempotency(key, ticket_id, created_at) VALUES (?, ?, ?)').run(key, ticketId, at);
  }

  private hydrate(r: TicketRow): Ticket {
    const events = this.db
      .prepare('SELECT at, kind, text, author FROM ticket_events WHERE ticket_id = ? ORDER BY seq')
      .all(r.id) as unknown as EventRow[];
    return {
      id: r.id,
      type: r.type as TicketType,
      title: r.title,
      description: r.description,
      category: r.category as Category,
      priority: r.priority as Priority,
      status: r.status as TicketStatus,
      requesterEmail: r.requester_email,
      affected: r.affected as Impact,
      assignedTeam: r.assigned_team,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      resolvedAt: r.resolved_at,
      events: events.map((e): TicketEvent => ({ at: e.at, kind: e.kind as TicketEventKind, text: e.text, author: e.author })),
    };
  }
}
