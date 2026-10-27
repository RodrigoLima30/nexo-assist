import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRightLeft,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Hand,
  Headset,
  Info,
  LogOut,
  MessageSquare,
  RotateCcw,
  Search,
  SendHorizontal,
  X,
} from 'lucide-react';
import type { ChatMessage, ConsoleConversationResponse, ConsoleFilter, ConsoleListItem, ConsoleListResponse, TicketView } from '@shared/chat';
import { firstName, isOpenStatus, PRIORITY_LABEL, STATUS_LABEL, type Person } from '@shared/domain';
import { formatDay, formatListTime, formatRelative, formatTime } from '@shared/sla';
import { DecisionPanel } from '../components/DecisionPanel';
import { Avatar, Dot, NexoMark, Spinner } from '../components/common';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { statusColor, statusTextColor } from '../lib/format';

const POLL_MS = 3000;

const FILTERS: { key: ConsoleFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'needs_you', label: 'Para você' },
  { key: 'with_agent', label: 'Com o agent' },
  { key: 'mine', label: 'Minhas' },
  { key: 'closed', label: 'Encerradas' },
];

function tagFor(it: ConsoleListItem, me: Person): { text: string; color: string; textColor: string } {
  if (it.mode === 'waiting_analyst') {
    if (it.handoff?.kind === 'low_confidence') {
      return { text: `Agent pediu ajuda · confiança ${Math.round((it.handoff.confidence ?? 0) * 100)}%`, color: 'var(--warning)', textColor: 'var(--warning-text)' };
    }
    const what = it.handoff?.kind === 'critical' ? 'caso crítico' : it.handoff?.kind === 'overdue' ? 'prazo vencido' : 'pedido do funcionário';
    return { text: `Transferida · ${it.ticketId ?? what}`, color: 'var(--danger)', textColor: 'var(--danger-text)' };
  }
  if (it.mode === 'analyst') {
    return it.assignedAnalyst?.email === me.email
      ? { text: 'Você está atendendo', color: 'var(--cta)', textColor: 'var(--primary-text)' }
      : { text: `Com ${it.assignedAnalyst?.name ?? 'analista'}`, color: 'var(--primary)', textColor: 'var(--ink-3)' };
  }
  if (it.mode === 'closed') return { text: it.resolvedBy === 'analyst' ? 'Encerrada pelo analista' : 'Encerrada', color: '#1B243155', textColor: 'var(--ink-3)' };
  if (it.resolvedBy === 'agent') return { text: 'Resolvida pelo agent', color: '#1B243155', textColor: 'var(--ink-3)' };
  return { text: 'Agent atendendo', color: 'var(--success)', textColor: 'var(--ink-3)' };
}

export function ConsolePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ConsoleFilter>('needs_you');
  const [q, setQ] = useState('');
  const [list, setList] = useState<ConsoleListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsoleConversationResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [reply, setReply] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const loadList = useCallback(async () => {
    try {
      setList(await api.consoleList(filter, q));
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'Não foi possível carregar as conversas.');
    }
  }, [filter, q]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.consoleDetail(id));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Não foi possível carregar a conversa.');
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = setInterval(() => void loadList(), POLL_MS);
    return () => clearInterval(t);
  }, [loadList]);

  // Seleciona a primeira conversa automaticamente.
  useEffect(() => {
    if (!selected && list?.items[0]) setSelected(list.items[0].id);
  }, [list, selected]);

  useEffect(() => {
    if (!selected) return;
    setDetailLoading(true);
    setActionError(null);
    void loadDetail(selected).finally(() => setDetailLoading(false));
    const t = setInterval(() => void loadDetail(selected), POLL_MS);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  useLayoutEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== lastCount.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    lastCount.current = n;
  }, [detail]);

  if (!user) return null;

  const act = async (fn: () => Promise<unknown>) => {
    if (!selected) return;
    setActing(true);
    setActionError(null);
    try {
      await fn();
      await Promise.all([loadDetail(selected), loadList()]);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'A ação falhou. Tente de novo.');
    } finally {
      setActing(false);
    }
  };

  const sendReply = () => {
    const text = reply.trim();
    if (!text || !selected) return;
    void act(async () => {
      await api.reply(selected, text);
      setReply('');
    });
  };

  const conv = detail?.conversation;
  const employee = detail?.employee;
  const mine = conv?.mode === 'analyst' && conv.assignedAnalyst?.email === user.email;
  const ticketId = conv?.handoff?.ticketId ?? conv?.focusTicketId ?? null;

  return (
    <div className="console">
      <nav className="rail" aria-label="Navegação do console">
        <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 8 }}>
          <NexoMark size={22} />
        </div>
        <button type="button" className="r-btn active" title="Conversas" onClick={() => setFilter('needs_you')}>
          <MessageSquare size={19} />
          {list && list.counts.needs_you > 0 && <span className="badge">{list.counts.needs_you}</span>}
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="r-btn"
          title="Sair"
          onClick={async () => {
            await logout();
            navigate('/entrar');
          }}
        >
          <LogOut size={18} />
        </button>
        <span title={`${user.name} · ${user.team}`}>
          <Avatar name={user.name} size={36} online ring="var(--desk)" />
        </span>
      </nav>

      <section className="chatlist" aria-label="Conversas">
        <div className="head">
          <div className="title-row">
            <h1>Conversas</h1>
            <span className="pill success">
              <Dot color="var(--success)" /> Disponível
            </span>
          </div>
          <label className="search">
            <Search size={15} />
            <input placeholder="Pesquisar conversa ou chamado" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar" />
          </label>
          <div className="filters" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
                {f.label}
                {f.key !== 'all' && list && <span className="c">{list.counts[f.key]}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="items">
          {listError && <div className="error-banner">{listError}</div>}
          {!list && !listError && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 64, margin: '6px 2px' }} />)}
          {list && list.items.length === 0 && <div className="empty">Nenhuma conversa neste filtro.</div>}
          {list?.items.map((it) => {
            const tag = tagFor(it, user);
            const last = it.lastMessage;
            const now = new Date();
            const prefix = last?.author === 'agent' ? 'Nexo: ' : last?.author === 'analyst' ? 'Você: ' : '';
            return (
              <button key={it.id} type="button" className={`item${selected === it.id ? ' active' : ''}${it.unread > 0 ? ' unread' : ''}`} onClick={() => setSelected(it.id)}>
                <Avatar name={it.employee.name} size={46} ring={selected === it.id ? 'var(--desk)' : 'var(--paper)'} />
                <span className="txt">
                  <span className="top">
                    <span className="name">{it.employee.name}</span>
                    {last && <span className="time">{formatListTime(last.at, now)}</span>}
                  </span>
                  <span className="bottom">
                    {last?.author === 'agent' && <CheckCheck size={15} color="var(--primary)" />}
                    <span className="last">
                      {prefix}
                      {last?.text ?? ''}
                    </span>
                    {it.unread > 0 && <span className="unread-n">{it.unread}</span>}
                  </span>
                  <span className="tag" style={{ color: tag.textColor }}>
                    <Dot color={tag.color} size={6} />
                    {tag.text}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="convo" aria-label="Conversa">
        {!selected || (!detail && !detailLoading) ? (
          <div className="empty">
            <MessageSquare size={28} />
            Selecione uma conversa
          </div>
        ) : !detail || !conv || !employee ? (
          <div className="empty">
            <Spinner dark />
          </div>
        ) : (
          <>
            <header className="convo-head">
              <Avatar name={employee.name} size={40} />
              <div className="who">
                <div className="n">{employee.name}</div>
                <div className="m">
                  {employee.department}
                  {employee.device ? ` · ${employee.os}` : ''}
                  {ticketId ? ` · ${ticketId}` : ''}
                </div>
              </div>
              {conv.mode === 'waiting_analyst' && (
                <span className="pill warning">
                  <Hand size={14} /> Aguardando atendente
                </span>
              )}
              {conv.mode === 'agent' && (
                <span className="pill success">
                  <Bot size={14} /> {conv.resolvedBy === 'agent' ? 'Resolvida pelo agent' : 'Agent atendendo'}
                </span>
              )}
              {conv.mode === 'closed' && <span className="pill neutral">Encerrada</span>}
              {conv.mode === 'analyst' && !mine && <span className="pill primary">Com {conv.assignedAnalyst?.name}</span>}
              {mine && (
                <>
                  <button type="button" className="btn btn-outline" disabled={acting} onClick={() => act(() => api.release(conv.id))}>
                    <RotateCcw size={14} /> Devolver ao agent
                  </button>
                  <button type="button" className="btn btn-danger" disabled={acting} onClick={() => act(() => api.close(conv.id))}>
                    <X size={14} /> Encerrar atendimento
                  </button>
                </>
              )}
            </header>

            <div className="convo-msgs" ref={scrollRef}>
              <div className="spacer" />
              <ConsoleMessages messages={detail.messages} />
            </div>

            {conv.handoff && (conv.mode === 'waiting_analyst' || conv.mode === 'analyst') && (
              <details className="handoff-card" open={conv.mode === 'waiting_analyst'}>
                <summary>
                  <ClipboardList size={15} /> Resumo do agent para o analista · {conv.handoff.team}
                  <ChevronDown size={14} style={{ marginLeft: 'auto' }} />
                </summary>
                <pre>{conv.handoff.summary}</pre>
              </details>
            )}

            {actionError && (
              <div className="error-banner" style={{ margin: '0 20px 10px' }}>
                {actionError}
                <button type="button" onClick={() => setActionError(null)}>
                  Fechar
                </button>
              </div>
            )}

            <div className="takeover">
              {conv.mode === 'waiting_analyst' && (
                <>
                  <div className="row">
                    <span className="ic">
                      <Hand size={17} />
                    </span>
                    <div className="tx">
                      <b>{firstName(employee.name)} espera um atendente</b>
                      <span>
                        Agent pausado · {conv.handoff?.reason ?? 'transferida'} · desde {conv.handoff ? formatTime(conv.handoff.at) : ''}
                      </span>
                    </div>
                    <button type="button" className="btn btn-outline" disabled={acting} onClick={() => act(() => api.release(conv.id))}>
                      <RotateCcw size={15} /> Devolver ao agent
                    </button>
                    <button type="button" className="btn btn-primary" disabled={acting} onClick={() => act(() => api.assume(conv.id))}>
                      {acting ? <Spinner /> : <Headset size={16} />} Assumir atendimento
                    </button>
                  </div>
                  <div className="locked">Assuma o atendimento para responder</div>
                </>
              )}
              {conv.mode === 'agent' && (
                <div className="row">
                  <span className="ic ok">
                    <Bot size={17} />
                  </span>
                  <div className="tx">
                    <b>{conv.resolvedBy === 'agent' ? 'O agent resolveu esta conversa' : 'O agent está atendendo'}</b>
                    <span>Você pode assumir a qualquer momento; o agent fica pausado enquanto você atende.</span>
                  </div>
                  <button type="button" className="btn btn-outline" disabled={acting} onClick={() => act(() => api.assume(conv.id))}>
                    <Headset size={15} /> Assumir
                  </button>
                </div>
              )}
              {conv.mode === 'analyst' && !mine && <div className="locked">{conv.assignedAnalyst?.name} está atendendo esta conversa.</div>}
              {conv.mode === 'closed' && <div className="locked">Atendimento encerrado.</div>}
              {mine && (
                <form
                  className="reply-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendReply();
                  }}
                >
                  <div className="inputbox">
                    <textarea
                      rows={1}
                      value={reply}
                      placeholder={`Responder para ${firstName(employee.name)}…`}
                      aria-label="Resposta"
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendReply();
                        }
                      }}
                    />
                  </div>
                  <button type="submit" className="send-round" disabled={acting || !reply.trim()} aria-label="Enviar">
                    <SendHorizontal size={18} />
                  </button>
                </form>
              )}
            </div>
          </>
        )}
      </section>

      {detail && employee && <TicketsPanel employee={employee} tickets={detail.tickets} currentId={ticketId} error={detail.ticketsError} />}
    </div>
  );
}

function ConsoleMessages({ messages }: { messages: ChatMessage[] }) {
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  let lastDay = '';
  return (
    <>
      {messages.map((m, i) => {
        const day = formatDay(m.createdAt);
        const dayPill = day !== lastDay ? <div className="day-pill">{day === formatDay(new Date().toISOString()) ? 'Hoje' : day}</div> : null;
        lastDay = day;
        const prev = messages[i - 1];
        const grouped = prev && prev.author === m.author && m.author === 'user';
        if (m.author === 'system') {
          return (
            <div key={m.id}>
              {dayPill}
              <div className="system-line">
                <span>
                  <ArrowRightLeft size={13} /> {m.text}
                </span>
              </div>
            </div>
          );
        }
        const right = m.author !== 'user';
        const blocksNote = m.blocks
          .map((b) =>
            b.kind === 'draft'
              ? `Rascunho ${b.draft.id} (${b.draft.mode === 'create' ? 'novo chamado' : b.draft.ticketId}) · ${b.state === 'confirmed' ? `confirmado → ${b.resultTicketId}` : b.state === 'pending' ? 'aguardando confirmação' : b.state === 'cancelled' ? 'cancelado' : 'substituído'}`
              : b.kind === 'ticket_card'
                ? `Card do ${b.ticket.id}`
                : b.kind === 'ticket_selector'
                  ? `Lista: ${b.tickets.map((t) => t.id).join(', ')}`
                  : b.kind === 'options'
                    ? `Opções: ${b.options.map((o) => o.label).join(' · ')}`
                    : b.kind === 'article'
                      ? `Artigo ${b.articleId}`
                      : null,
          )
          .filter(Boolean);
        return (
          <div key={m.id}>
            {dayPill}
            <div className={`cmsg${right ? ' right' : ''}${m.author === 'analyst' ? ' human' : ''}${grouped ? ' grouped' : ''}`}>
              {m.author !== 'user' && (
                <div className="sender">
                  {m.authorName ?? 'Nexo Assist'}
                  {m.author === 'agent' ? <span className="tag-chip ai">IA</span> : m.authorTag ? <span className="tag-chip team">{m.authorTag}</span> : null}
                  {m.trace && (
                    <button type="button" className="why-btn" onClick={() => setOpenTrace(openTrace === m.id ? null : m.id)}>
                      <Info size={12} /> {openTrace === m.id ? 'Ocultar' : 'Por quê?'}
                    </button>
                  )}
                </div>
              )}
              <div className="cbubble">
                <span className="t">{m.text}</span>
                {blocksNote.length > 0 && <span className="blocks-note">{blocksNote.join(' · ')}</span>}
                <span className="meta">
                  {formatTime(m.createdAt)}
                  {right && <CheckCheck size={14} color="var(--primary)" />}
                </span>
              </div>
              {openTrace === m.id && m.trace && <DecisionPanel trace={m.trace} />}
            </div>
          </div>
        );
      })}
    </>
  );
}

function TicketsPanel({ employee, tickets, currentId, error }: { employee: Person; tickets: TicketView[]; currentId: string | null; error: string | null }) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = new Date();
  const open = tickets.filter((t) => isOpenStatus(t.status));
  const closed = tickets.filter((t) => !isOpenStatus(t.status));
  const current = tickets.find((t) => t.id === currentId) ?? null;
  const others = [...open, ...closed].filter((t) => t.id !== current?.id);
  const visible = showAll ? others : others.slice(0, 4);
  const first = firstName(employee.name);

  return (
    <aside className="tickets-panel" aria-label={`Chamados de ${first}`}>
      <div className="ph">
        <div style={{ flex: 1 }}>
          <div className="n">
            Chamados {first.endsWith('a') ? 'da' : 'do'} {first}
          </div>
          <div className="m">
            {open.length} abertos · {closed.length} encerrados
          </div>
        </div>
      </div>
      <div className="pb">
        {error && <div className="error-banner">{error}</div>}
        {current && (
          <div>
            <div className="lbl">Desta conversa</div>
            <div className="current-ticket">
              <div>
                <div className="r">
                  <span className="num">{current.id}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: current.overdue ? 'var(--danger-text)' : statusTextColor(current.status) }}>
                    <Dot color={current.overdue ? 'var(--danger)' : statusColor(current.status)} />
                    {STATUS_LABEL[current.status]}
                    {current.overdue ? ' · vencido' : ''}
                  </span>
                </div>
                <div className="tt">{current.title}</div>
                <div className="muted" style={{ fontSize: 13.5 }}>
                  {current.category} · prioridade {PRIORITY_LABEL[current.priority].toLowerCase()}
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.5 }}>{current.description}</div>
              </div>
              {current.lastEvent && (
                <div className="last-ev">
                  <ArrowRightLeft size={15} color="var(--ink-3)" />
                  <span style={{ flex: 1 }}>{current.lastEvent.text}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {formatRelative(current.lastEvent.at, now)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        <div>
          <div className="lbl">{current ? 'Outros chamados' : 'Chamados'}</div>
          {others.length === 0 && <div className="muted">Nenhum outro chamado.</div>}
          {visible.map((t) => (
            <div key={t.id}>
              <button type="button" className="ticket-row" onClick={() => setExpanded(expanded === t.id ? null : t.id)} aria-expanded={expanded === t.id}>
                <Dot color={t.overdue ? 'var(--danger)' : statusColor(t.status)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div className="tt">{t.title}</div>
                  <div className="mm">
                    {t.id} · {t.status === 'resolvido' && t.resolvedAt ? `Resolvido em ${formatDay(t.resolvedAt)}` : STATUS_LABEL[t.status]}
                    {t.overdue ? ' · prazo vencido' : ''}
                  </div>
                </span>
                {expanded === t.id ? <ChevronDown size={16} color="var(--ink-3)" /> : <ChevronRight size={16} color="var(--ink-3)" />}
              </button>
              {expanded === t.id && (
                <div className="ticket-detail">
                  {t.description}
                  <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                    {t.category} · {PRIORITY_LABEL[t.priority]} · atualizado {formatRelative(t.updatedAt, now)}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {others.length > 4 && (
        <div className="pf">
          <button type="button" className="btn btn-outline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Mostrar menos' : `Ver todos os chamados ${first.endsWith('a') ? 'da' : 'do'} ${first}`}
          </button>
        </div>
      )}
    </aside>
  );
}
