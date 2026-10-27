import { useState } from 'react';
import { AlertTriangle, CheckCheck, Info, Loader2 } from 'lucide-react';
import type { ChatMessage, ClientAction, TraceStep } from '@shared/chat';
import { ArticleChip, DraftCard, HandoffChip, OptionsBlock, TicketCard, TicketSelector } from './Blocks';
import { DecisionPanel } from './DecisionPanel';

type Send = (label: string, action: ClientAction) => void;

export function StatusLine({ steps, live = false, onWhy, whyOpen }: { steps: TraceStep[]; live?: boolean; onWhy?: () => void; whyOpen?: boolean }) {
  const visible = steps.filter((s) => s.visible);
  return (
    <div className="status-line">
      <span className="who">Nexo Assist</span>
      {visible.map((s) => (
        <span key={s.id} className={`step${s.status === 'error' ? ' error' : ''}`} title={s.detail ?? undefined}>
          {s.status === 'error' ? <AlertTriangle size={12} /> : <CheckCheck size={12} />}
          {s.label}
        </span>
      ))}
      {live && (
        <span className="step running">
          <Loader2 size={12} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
          {visible.length ? 'pensando…' : 'lendo sua mensagem…'}
        </span>
      )}
      {onWhy && (
        <button type="button" className="why-btn" onClick={onWhy} aria-expanded={whyOpen}>
          <Info size={12} /> {whyOpen ? 'Ocultar detalhes' : 'Por quê?'}
        </button>
      )}
    </div>
  );
}

/**
 * Uma resposta do agent: linha de ações (o que ele fez), botão "Por quê?" com a trilha
 * completa, o texto e os blocos interativos. Blocos de mensagens antigas ficam
 * desabilitados e mostram o que o funcionário escolheu.
 */
export function AgentMessage({ message, active, nextUserText, onSend, busy }: { message: ChatMessage; active: boolean; nextUserText: string | null; onSend: Send; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const disabled = !active || busy;
  const options = message.blocks.filter((b) => b.kind === 'options');
  const cards = message.blocks.filter((b) => b.kind !== 'options');
  const selectedTicket = nextUserText?.match(/^(INC|REQ)-\d{5}/)?.[0] ?? null;
  // Como no protótipo (Tela 3): ao mostrar um chamado com uma pergunta, o card vem antes do texto.
  const ticketFirst = options.length > 0 ? cards.filter((b) => b.kind === 'ticket_card') : [];

  return (
    <div className="msg-agent">
      <StatusLine steps={message.trace?.steps ?? []} onWhy={message.trace ? () => setOpen((v) => !v) : undefined} whyOpen={open} />
      {open && message.trace && <DecisionPanel trace={message.trace} />}
      {ticketFirst.map((b, i) => (b.kind === 'ticket_card' ? <TicketCard key={`first-${i}`} ticket={b.ticket} /> : null))}
      {(message.text || options.length > 0) && (
        <div className="agent-bubble">
          {message.text && <div className="text">{message.text}</div>}
          {options.map((b, i) =>
            b.kind === 'options' ? <OptionsBlock key={i} question={b.question} options={b.options} onSend={onSend} disabled={disabled} selectedLabel={nextUserText} /> : null,
          )}
        </div>
      )}
      {cards.map((b, i) => {
        switch (b.kind) {
          case 'ticket_card':
            return ticketFirst.length ? null : <TicketCard key={i} ticket={b.ticket} />;
          case 'ticket_selector':
            return <TicketSelector key={i} tickets={b.tickets} purpose={b.purpose} onSend={onSend} disabled={disabled} selectedId={selectedTicket} />;
          case 'draft':
            return <DraftCard key={b.draft.id} draft={b.draft} state={b.state} resultTicketId={b.resultTicketId} onSend={onSend} disabled={busy} />;
          case 'article':
            return <ArticleChip key={i} id={b.articleId} title={b.title} />;
          case 'handoff':
            return <HandoffChip key={i} team={b.team} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

export function AnalystMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="msg-agent">
      <div className="status-line">
        <span className="who analyst">
          {message.authorName}
          {message.authorTag && <span className="tag-chip team">{message.authorTag}</span>}
        </span>
      </div>
      <div className="agent-bubble human">
        <div className="text">{message.text}</div>
      </div>
    </div>
  );
}
