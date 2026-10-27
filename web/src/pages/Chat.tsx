import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Headset, Info, Lock, Plus, SendHorizontal } from 'lucide-react';
import type { ChatMessage, ClientAction, ConversationView, TraceStep } from '@shared/chat';
import { firstName } from '@shared/domain';
import { AgentMessage, AnalystMessage, StatusLine } from '../components/AgentMessage';
import { Dot, Spinner } from '../components/common';
import { EmployeeShell } from '../components/EmployeeShell';
import { api, ApiError, sendMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface LiveReply {
  steps: TraceStep[];
  text: string;
}

const POLL_MS = 3000;

export function ChatPage() {
  const { user } = useAuth();
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveReply | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = live !== null;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api.conversation();
      setConversation(r.conversation);
      setMessages(r.messages);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Não foi possível carregar a conversa.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Enquanto a conversa está com um analista, busca mensagens novas periodicamente.
  useEffect(() => {
    if (!conversation || busy || conversation.mode === 'agent' || conversation.mode === 'closed') return;
    const id = conversation.id;
    const timer = setInterval(() => {
      api
        .conversationById(id)
        .then((r) => {
          setConversation(r.conversation);
          setMessages(r.messages);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [conversation, busy]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const send = useCallback(
    async (text: string, action?: ClientAction) => {
      if (!conversation || busy) return;
      const clean = text.trim();
      if (!clean) return;
      setError(null);
      setNotice(null);
      setLive({ steps: [], text: '' });
      try {
        await sendMessage({ conversationId: conversation.id, text: clean, action }, (e) => {
          switch (e.type) {
            case 'user_message':
              setMessages((m) => [...m, e.message]);
              setDraft('');
              break;
            case 'step':
              setLive((l) => (l ? { ...l, steps: [...l.steps.filter((s) => s.id !== e.step.id), e.step] } : l));
              break;
            case 'delta':
              setLive((l) => (l ? { ...l, text: l.text + e.text } : l));
              break;
            case 'agent_message':
              setMessages((m) => [...m, e.message]);
              break;
            case 'conversation':
              setConversation(e.conversation);
              break;
            case 'paused':
              setNotice(e.reason);
              break;
            case 'error':
              setError(e.message);
              break;
            case 'done':
              break;
          }
        });
        // Sincroniza estados que mudam em mensagens antigas (ex.: rascunho confirmado).
        const r = await api.conversationById(conversation.id);
        setConversation(r.conversation);
        setMessages(r.messages);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Não foi possível enviar. Tente de novo.');
      } finally {
        setLive(null);
        inputRef.current?.focus();
      }
    },
    [conversation, busy],
  );

  const startNew = async () => {
    setError(null);
    try {
      const r = await api.newConversation();
      setConversation(r.conversation);
      setMessages(r.messages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível iniciar uma nova conversa.');
    }
  };

  if (!user) return null;

  const mode = conversation?.mode ?? 'agent';
  const limitReached = conversation ? conversation.userMessageCount >= conversation.maxUserMessages : false;
  const canType = conversation !== null && mode !== 'closed' && !limitReached;
  const lastAgentIdx = messages.reduce((acc, m, i) => (m.author === 'agent' ? i : acc), -1);

  const statusPill =
    mode === 'agent' ? (
      <span className="pill success">
        <Dot color="var(--success)" /> Assistente online
      </span>
    ) : mode === 'waiting_analyst' ? (
      <span className="pill warning">
        <Dot color="var(--warning)" /> Aguardando analista
      </span>
    ) : mode === 'analyst' ? (
      <span className="pill primary">
        <Dot color="var(--cta)" /> Com {conversation?.assignedAnalyst ? firstName(conversation.assignedAnalyst.name) : 'um analista'}
      </span>
    ) : (
      <span className="pill neutral">
        <Dot color="#1B243155" /> Atendimento encerrado
      </span>
    );

  return (
    <EmployeeShell
      title="Atendimento"
      right={
        <>
          {messages.length > 0 && (mode === 'agent' || mode === 'closed') && (
            <button type="button" className="btn btn-ghost" onClick={startNew} disabled={busy}>
              <Plus size={15} /> Nova conversa
            </button>
          )}
          {statusPill}
        </>
      }
    >
      <div className="chat">
        <div className="messages" ref={scrollRef} aria-live="polite">
          <div className="spacer" />
          {loadError && (
            <div className="error-banner">
              {loadError}
              <button type="button" onClick={load}>
                Tentar de novo
              </button>
            </div>
          )}
          {!conversation && !loadError && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="skeleton" style={{ height: 44, width: '55%', alignSelf: 'flex-end' }} />
              <div className="skeleton" style={{ height: 88, width: '75%' }} />
            </div>
          )}
          {conversation && messages.length === 0 && !busy && (
            <div className="welcome">
              <h3>Olá, {firstName(user.name)}. Como posso ajudar?</h3>
              <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
                Descreva o que está acontecendo com suas palavras. Eu consulto seus chamados, busco na central de ajuda, abro ou atualizo chamados e
                chamo um analista quando precisa.
              </p>
              <div className="options" style={{ marginTop: 6 }}>
                {['Meu notebook não conecta na VPN, aparece o erro 809', 'Qual o status do meu chamado?', 'Qual o horário do service desk?'].map((s) => (
                  <button key={s} type="button" className="option" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const next = messages.slice(i + 1).find((x) => x.author === 'user');
            if (m.author === 'user') {
              return (
                <div className="msg-user" key={m.id}>
                  <div className="bubble">{m.text}</div>
                </div>
              );
            }
            if (m.author === 'system') {
              return (
                <div className="system-line" key={m.id}>
                  <span>
                    <Headset size={13} /> {m.text}
                  </span>
                </div>
              );
            }
            if (m.author === 'analyst') return <AnalystMessage key={m.id} message={m} />;
            return (
              <AgentMessage
                key={m.id}
                message={m}
                active={i === lastAgentIdx && !next && mode === 'agent'}
                nextUserText={next?.text ?? null}
                onSend={send}
                busy={busy}
              />
            );
          })}
          {live && (
            <div className="msg-agent">
              <StatusLine steps={live.steps} live />
              <div className="agent-bubble">
                {live.text ? (
                  <div className="text">{live.text}</div>
                ) : (
                  <span className="typing" aria-label="Digitando">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="composer-area">
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)}>
                Fechar
              </button>
            </div>
          )}
          {mode === 'waiting_analyst' && (
            <div className="paused-banner">
              <Headset size={16} /> Você está na fila do {conversation?.handoff?.team ?? 'service desk'}. O assistente está em pausa; pode deixar mais detalhes que o analista vai ler.
            </div>
          )}
          {mode === 'analyst' && (
            <div className="paused-banner analyst">
              <Headset size={16} /> {conversation?.assignedAnalyst?.name} está atendendo você.
            </div>
          )}
          {notice && mode === 'agent' && (
            <div className="paused-banner">
              <Info size={16} /> {notice}
            </div>
          )}
          {mode === 'closed' ? (
            <div className="paused-banner closed">
              <Lock size={16} /> Este atendimento foi encerrado.
              <button type="button" className="btn btn-primary" onClick={startNew}>
                <Plus size={15} /> Nova conversa
              </button>
            </div>
          ) : limitReached ? (
            <div className="paused-banner closed">
              <Lock size={16} /> Você atingiu o limite de {conversation?.maxUserMessages} mensagens nesta sessão.
              <button type="button" className="btn btn-primary" onClick={startNew} disabled={mode !== 'agent'}>
                <Plus size={15} /> Nova conversa
              </button>
            </div>
          ) : (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                placeholder={mode === 'agent' ? 'Escreva para o Nexo…' : 'Escreva para o analista…'}
                aria-label="Mensagem"
                maxLength={2000}
                disabled={!canType}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={!canType || busy || !draft.trim()}>
                {busy ? <Spinner /> : <SendHorizontal size={14} />} Enviar
              </button>
            </form>
          )}
          <div className="composer-meta">
            <span>{mode === 'agent' ? 'O Nexo Assist pode errar — confira os rascunhos antes de confirmar.' : ''}</span>
            {conversation && (
              <span className={limitReached ? 'limit' : ''}>
                {conversation.userMessageCount}/{conversation.maxUserMessages} mensagens nesta sessão
              </span>
            )}
          </div>
        </div>
      </div>
    </EmployeeShell>
  );
}
