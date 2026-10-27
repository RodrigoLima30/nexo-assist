import { useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, Headset, Pencil, XCircle } from 'lucide-react';
import type { ClientAction, Draft, DraftEdits, DraftState, QuickOption, SelectorPurpose, TicketSummary, TicketView } from '@shared/chat';
import { CATEGORIES, IMPACT_LABEL, IMPACTS, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, type Impact, type Priority } from '@shared/domain';
import { formatDateTime, formatDay, formatDue, formatRelative } from '@shared/sla';
import { priorityColor, statusColor, statusTextColor } from '../lib/format';
import { Dot } from './common';

type Send = (label: string, action: ClientAction) => void;

export function OptionsBlock({ question, options, onSend, disabled, selectedLabel }: { question: string | null; options: QuickOption[]; onSend: Send; disabled: boolean; selectedLabel: string | null }) {
  return (
    <>
      {question && <div className="question">{question}</div>}
      <div className="options" role="group" aria-label={question ?? 'Opções'}>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`option${selectedLabel && (selectedLabel === o.label || selectedLabel.startsWith(`${o.label}.`)) ? ' selected' : ''}`}
            disabled={disabled}
            onClick={() => onSend(o.label, o.action)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function TicketSelector({ tickets, purpose, onSend, disabled, selectedId }: { tickets: TicketSummary[]; purpose: SelectorPurpose; onSend: Send; disabled: boolean; selectedId: string | null }) {
  return (
    <div className="selector" role="radiogroup" aria-label="Seus chamados">
      {tickets.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={selectedId === t.id}
          className={selectedId === t.id ? 'selected' : ''}
          disabled={disabled}
          onClick={() => onSend(`${t.id} · ${t.title}`, { type: 'select_ticket', ticketId: t.id, purpose })}
        >
          <span className="radio" />
          <span className="num">{t.id}</span>
          <span className="t">{t.title}</span>
          <span className="st">
            <Dot color={t.overdue ? 'var(--danger)' : statusColor(t.status)} size={6} />
            {t.overdue ? 'Prazo vencido' : STATUS_LABEL[t.status]}
          </span>
          <span className="d">{formatDay(t.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

export function TicketCard({ ticket }: { ticket: TicketView }) {
  const now = new Date();
  return (
    <article className="card" aria-label={`Chamado ${ticket.id}`}>
      <div className="body">
        <div className="eyebrow">
          <span style={{ fontWeight: 500 }}>Chamado</span>
          <span className="sep" />
          <span>{ticket.id}</span>
          <span className="state" style={{ color: statusTextColor(ticket.status) }}>
            <Dot color={statusColor(ticket.status)} size={6} />
            {STATUS_LABEL[ticket.status]}
          </span>
        </div>
        <div className="title">{ticket.title}</div>
        <div className="desc">{ticket.description}</div>
      </div>
      <div className="fields">
        <div>
          <div className="k">Categoria</div>
          <div className="v">{ticket.category}</div>
        </div>
        <div>
          <div className="k">Prioridade</div>
          <div className="v">
            <Dot color={priorityColor(ticket.priority)} size={6} />
            {PRIORITY_LABEL[ticket.priority]}
          </div>
        </div>
        <div>
          <div className="k">Aberto em</div>
          <div className="v">{formatDateTime(ticket.createdAt)}</div>
        </div>
        <div>
          <div className="k">Última atualização</div>
          <div className="v">
            <span style={{ color: ticket.overdue ? 'var(--warning-text)' : undefined }}>{formatRelative(ticket.updatedAt, now)}</span>
            {ticket.overdue ? (
              <span className="note">· prazo vencido</span>
            ) : ticket.dueAt ? (
              <span className="note">· próxima até {formatDue(ticket.dueAt, now)}</span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

const DRAFT_KIND: Record<Draft['mode'], string> = { create: 'Novo chamado', update: 'Atualizar chamado', reopen: 'Reabrir chamado' };

export function DraftCard({ draft, state, resultTicketId, onSend, disabled }: { draft: Draft; state: DraftState; resultTicketId: string | null; onSend: Send; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<DraftEdits>({});
  const pending = state === 'pending';
  const view = { ...draft, ...edits };
  const now = new Date();

  const confirm = () => {
    const changed = Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== (draft as unknown as Record<string, unknown>)[k])) as DraftEdits;
    onSend(Object.keys(changed).length ? 'Confirmar com alterações' : 'Confirmar', { type: 'confirm_draft', draftId: draft.id, edits: Object.keys(changed).length ? changed : undefined });
    setEditing(false);
  };

  // ⌘/Ctrl + Enter confirma o rascunho pendente, como no protótipo.
  useEffect(() => {
    if (!pending || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stateLabel =
    state === 'pending'
      ? { text: 'Aguardando confirmação', color: 'var(--warning)', tc: 'var(--warning-text)' }
      : state === 'confirmed'
        ? { text: draft.mode === 'create' ? `Criado · ${resultTicketId}` : `Enviado · ${resultTicketId}`, color: 'var(--success)', tc: 'var(--success-text)' }
        : state === 'cancelled'
          ? { text: 'Cancelado', color: '#1B243155', tc: 'var(--ink-3)' }
          : { text: 'Substituído', color: '#1B243155', tc: 'var(--ink-3)' };

  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  return (
    <article className="card" aria-label={`Rascunho ${draft.id}`} style={{ opacity: state === 'cancelled' || state === 'superseded' ? 0.7 : 1 }}>
      <div className="body">
        <div className="eyebrow">
          <span style={{ fontWeight: 500 }}>{DRAFT_KIND[draft.mode]}</span>
          <span className="sep" />
          <span>
            Rascunho {draft.id}
            {draft.ticketId ? ` · ${draft.ticketId}` : ''}
          </span>
          <span className="state" style={{ color: stateLabel.tc }}>
            <Dot color={stateLabel.color} size={6} />
            {stateLabel.text}
          </span>
        </div>
        {editing && draft.mode === 'create' ? null : (
          <>
            <div className="title">{view.title}</div>
            {draft.mode === 'create' && <div className="desc">{view.description}</div>}
          </>
        )}
      </div>

      {draft.mode !== 'create' &&
        (editing ? (
          <div className="edit-grid">
            <label className="wide">
              Informação a acrescentar
              <textarea value={view.comment ?? ''} onChange={(e) => setEdits({ ...edits, comment: e.target.value })} />
            </label>
          </div>
        ) : (
          <div className="comment">
            <div className="k">{draft.mode === 'update' ? 'Será acrescentado ao chamado' : 'Motivo da reabertura'}</div>
            {view.comment}
          </div>
        ))}

      {editing && draft.mode === 'create' ? (
        <div className="edit-grid">
          <label className="wide">
            Título
            <input value={view.title} onChange={(e) => setEdits({ ...edits, title: e.target.value })} maxLength={120} />
          </label>
          <label className="wide">
            Descrição
            <textarea value={view.description} onChange={(e) => setEdits({ ...edits, description: e.target.value })} />
          </label>
          <label>
            Categoria
            <select value={view.category} onChange={(e) => setEdits({ ...edits, category: e.target.value as Draft['category'] })}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Prioridade
            <select value={view.priority} onChange={(e) => setEdits({ ...edits, priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Afetados
            <select value={view.affected} onChange={(e) => setEdits({ ...edits, affected: e.target.value as Impact })}>
              {IMPACTS.map((i) => (
                <option key={i} value={i}>
                  {IMPACT_LABEL[i]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="fields">
          <div>
            <div className="k">Categoria</div>
            <div className="v">{view.category}</div>
          </div>
          <div>
            <div className="k">Prioridade</div>
            <div className="v">
              <Dot color={priorityColor(view.priority)} size={6} />
              {PRIORITY_LABEL[view.priority]}
              {pending && <span className="note">· resposta até {formatDue(draft.dueAt, now)}</span>}
            </div>
          </div>
          <div>
            <div className="k">Afetados</div>
            <div className="v">{IMPACT_LABEL[view.affected]}</div>
          </div>
        </div>
      )}

      {pending && (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={disabled}>
            Confirmar <span className="kbd">{isMac ? '⌘↵' : 'Ctrl↵'}</span>
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setEditing((v) => !v)} disabled={disabled}>
            <Pencil size={14} /> {editing ? 'Fechar edição' : 'Editar'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onSend('Cancelar', { type: 'cancel_draft', draftId: draft.id })}
            disabled={disabled}
          >
            Cancelar
          </button>
        </div>
      )}
      {!pending && (
        <div className="actions">
          <span className="done">
            {state === 'confirmed' ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--ink-3)" />}
            {state === 'confirmed' ? `Registrado no sistema de chamados como ${resultTicketId}.` : state === 'cancelled' ? 'Nada foi enviado.' : 'Substituído por um rascunho mais novo.'}
          </span>
        </div>
      )}
    </article>
  );
}

export function ArticleChip({ id, title }: { id: string; title: string }) {
  return (
    <span className="article-chip">
      <BookOpen size={14} /> Central de ajuda · {id} — {title}
    </span>
  );
}

export function HandoffChip({ team }: { team: string }) {
  return (
    <span className="handoff-chip">
      <Headset size={15} /> Encaminhado ao {team} · agent em pausa
    </span>
  );
}
