import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Author, Block, ChatMessage, ConversationMode, DecisionTrace, DraftState, Handoff } from '@shared/chat';
import { initialState, type AgentState } from '../agent/state';
import { transaction } from '../lib/sqlite';

/**
 * Persistência da API: sessões, conversas (com o estado do agent e o modo — agent,
 * aguardando atendente, com analista, encerrada) e mensagens com a trilha de decisão.
 * Tudo em SQLite, então sobrevive a um reinício.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  mode TEXT NOT NULL,
  assigned_email TEXT,
  assigned_name TEXT,
  handoff_json TEXT,
  state_json TEXT NOT NULL,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_email, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  author TEXT NOT NULL,
  author_name TEXT,
  author_tag TEXT,
  text TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  trace_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
`;

export interface ConversationRecord {
  id: string;
  userEmail: string;
  mode: ConversationMode;
  assignedAnalyst: { email: string; name: string } | null;
  handoff: Handoff | null;
  state: AgentState;
  userMessageCount: number;
  resolvedBy: 'agent' | 'analyst' | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  id: string;
  user_email: string;
  mode: string;
  assigned_email: string | null;
  assigned_name: string | null;
  handoff_json: string | null;
  state_json: string;
  user_message_count: number;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  author: string;
  author_name: string | null;
  author_tag: string | null;
  text: string;
  blocks_json: string;
  trace_json: string | null;
  created_at: string;
}

const SESSION_TTL_DAYS = 14;

export class Store {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
  }

  // ---- Sessões -------------------------------------------------------------

  createSession(email: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
    this.db.prepare('INSERT INTO sessions(token, email, created_at, expires_at) VALUES (?,?,?,?)').run(token, email, now.toISOString(), expires.toISOString());
    return token;
  }

  sessionEmail(token: string): string | null {
    const row = this.db.prepare('SELECT email, expires_at FROM sessions WHERE token = ?').get(token) as { email: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < this.clock().getTime()) {
      this.deleteSession(token);
      return null;
    }
    return row.email;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ---- Conversas -----------------------------------------------------------

  createConversation(userEmail: string, at?: string): ConversationRecord {
    const now = at ?? this.clock().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversations(id, user_email, mode, state_json, user_message_count, created_at, updated_at)
         VALUES (?, ?, 'agent', ?, 0, ?, ?)`,
      )
      .run(id, userEmail, JSON.stringify(initialState()), now, now);
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? hydrateConversation(row) : null;
  }

  /** A conversa em andamento do funcionário (a mais recente que não foi encerrada). */
  currentConversation(userEmail: string): ConversationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE user_email = ? AND mode != 'closed' ORDER BY updated_at DESC LIMIT 1")
      .get(userEmail) as ConversationRow | undefined;
    return row ? hydrateConversation(row) : null;
  }

  latestConversation(userEmail: string): ConversationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE user_email = ? ORDER BY updated_at DESC LIMIT 1')
      .get(userEmail) as ConversationRow | undefined;
    return row ? hydrateConversation(row) : null;
  }

  listConversations(): ConversationRecord[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as ConversationRow[];
    return rows.map(hydrateConversation);
  }

  updateConversation(id: string, patch: Partial<Omit<ConversationRecord, 'id' | 'userEmail' | 'createdAt'>>): ConversationRecord {
    const cur = this.getConversation(id);
    if (!cur) throw new Error(`Conversa ${id} não encontrada`);
    const next = { ...cur, ...patch, updatedAt: patch.updatedAt ?? this.clock().toISOString() };
    this.db
      .prepare(
        `UPDATE conversations SET mode = ?, assigned_email = ?, assigned_name = ?, handoff_json = ?, state_json = ?,
         user_message_count = ?, resolved_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.mode,
        next.assignedAnalyst?.email ?? null,
        next.assignedAnalyst?.name ?? null,
        next.handoff ? JSON.stringify(next.handoff) : null,
        JSON.stringify(next.state),
        next.userMessageCount,
        next.resolvedBy,
        next.updatedAt,
        id,
      );
    return next;
  }

  // ---- Mensagens -----------------------------------------------------------

  addMessage(m: {
    conversationId: string;
    author: Author;
    authorName?: string | null;
    authorTag?: string | null;
    text: string;
    blocks?: Block[];
    trace?: DecisionTrace | null;
    createdAt?: string;
  }): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      conversationId: m.conversationId,
      author: m.author,
      authorName: m.authorName ?? null,
      authorTag: m.authorTag ?? null,
      text: m.text,
      blocks: m.blocks ?? [],
      trace: m.trace ?? null,
      createdAt: m.createdAt ?? this.clock().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages(id, conversation_id, author, author_name, author_tag, text, blocks_json, trace_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(msg.id, msg.conversationId, msg.author, msg.authorName, msg.authorTag, msg.text, JSON.stringify(msg.blocks), msg.trace ? JSON.stringify(msg.trace) : null, msg.createdAt);
    return msg;
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as unknown as MessageRow[];
    return rows.map(hydrateMessage);
  }

  lastMessage(conversationId: string): ChatMessage | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND author != 'system' ORDER BY seq DESC LIMIT 1")
      .get(conversationId) as MessageRow | undefined;
    return row ? hydrateMessage(row) : null;
  }

  /** Mensagens do funcionário desde a última resposta (do agent ou do analista). */
  unreadFromUser(conversationId: string): number {
    const rows = this.db.prepare('SELECT author FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 30').all(conversationId) as unknown as {
      author: string;
    }[];
    let n = 0;
    for (const r of rows) {
      if (r.author === 'user') n++;
      else if (r.author === 'agent' || r.author === 'analyst') break;
    }
    return n;
  }

  /** Atualiza o estado do card de rascunho na mensagem em que ele foi mostrado. */
  resolveDraftBlock(conversationId: string, draftId: string, state: DraftState, resultTicketId: string | null): void {
    transaction(this.db, () => {
      const rows = this.db
        .prepare("SELECT id, blocks_json FROM messages WHERE conversation_id = ? AND blocks_json LIKE '%\"draft\"%'")
        .all(conversationId) as unknown as { id: string; blocks_json: string }[];
      for (const row of rows) {
        const blocks = JSON.parse(row.blocks_json) as Block[];
        let changed = false;
        for (const b of blocks) {
          if (b.kind === 'draft' && b.draft.id === draftId && b.state === 'pending') {
            b.state = state;
            b.resultTicketId = resultTicketId;
            changed = true;
          }
        }
        if (changed) this.db.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run(JSON.stringify(blocks), row.id);
      }
    });
  }

  countConversations(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  }
}

function hydrateConversation(r: ConversationRow): ConversationRecord {
  return {
    id: r.id,
    userEmail: r.user_email,
    mode: r.mode as ConversationMode,
    assignedAnalyst: r.assigned_email ? { email: r.assigned_email, name: r.assigned_name ?? r.assigned_email } : null,
    handoff: r.handoff_json ? (JSON.parse(r.handoff_json) as Handoff) : null,
    state: { ...initialState(), ...(JSON.parse(r.state_json) as Partial<AgentState>) },
    userMessageCount: r.user_message_count,
    resolvedBy: (r.resolved_by as 'agent' | 'analyst' | null) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hydrateMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    author: r.author as Author,
    authorName: r.author_name,
    authorTag: r.author_tag,
    text: r.text,
    blocks: JSON.parse(r.blocks_json) as Block[],
    trace: r.trace_json ? (JSON.parse(r.trace_json) as DecisionTrace) : null,
    createdAt: r.created_at,
  };
}
