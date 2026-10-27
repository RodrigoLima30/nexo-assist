import { AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react';
import type { DecisionTrace } from '@shared/chat';
import { INTENT_LABEL } from '@shared/chat';

const INTERPRETER_LABEL: Record<DecisionTrace['interpreter'], string> = {
  llm: 'LLM',
  offline: 'regras offline (sem LLM)',
  action: 'clique em opção (sem LLM)',
  fallback: 'regras offline (LLM falhou)',
};

function confidenceColor(c: number): string {
  if (c >= 0.75) return 'var(--success)';
  if (c >= 0.5) return 'var(--warning)';
  return 'var(--danger)';
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/**
 * "Por que o agent fez isso?" — o que entendeu, que ação tomou, com que segurança,
 * por quê, quais regras do service desk aplicou e cada passo (ferramenta, tempo, dados).
 */
export function DecisionPanel({ trace }: { trace: DecisionTrace }) {
  const pct = Math.round(trace.confidence * 100);
  const facts = Object.entries(trace.facts);
  return (
    <section className="decision" aria-label="Detalhes da decisão do agent">
      <div className="row2">
        <div>
          <h4>O que entendi</h4>
          <div>{trace.understood}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            Intenção: {INTENT_LABEL[trace.intent]}
          </div>
        </div>
        <div>
          <h4>Ação</h4>
          <div style={{ fontWeight: 600 }}>{trace.action.label}</div>
          <h4 style={{ marginTop: 10 }}>Segurança</h4>
          <div className="confbar">
            <i style={{ width: `${pct}%`, background: confidenceColor(trace.confidence) }} />
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {pct}% · {INTERPRETER_LABEL[trace.interpreter]}
          </div>
        </div>
      </div>

      {facts.length > 0 && (
        <div>
          <h4>Fatos considerados</h4>
          <div className="facts">
            {facts.map(([k, v]) => (
              <span className="fact" key={k}>
                <b>{k}</b>
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {trace.reasoning && (
        <div>
          <h4>Por quê</h4>
          <div style={{ lineHeight: 1.5 }}>{trace.reasoning}</div>
        </div>
      )}

      {trace.rules.length > 0 && (
        <div>
          <h4>Regras do service desk aplicadas</h4>
          <ul>
            {trace.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {trace.steps.length > 0 && (
        <div>
          <h4>Passos ({trace.steps.length})</h4>
          <div className="steps">
            {trace.steps.map((s) => (
              <details key={s.id}>
                <summary>
                  {s.status === 'ok' ? (
                    <CheckCircle2 size={14} color="var(--success)" />
                  ) : s.status === 'error' ? (
                    <AlertTriangle size={14} color="var(--danger)" />
                  ) : (
                    <CircleSlash size={14} color="var(--ink-3)" />
                  )}
                  <span>
                    {s.label} <span className="tool">{s.tool}</span>
                  </span>
                  <span className="ms">{s.durationMs} ms</span>
                  {s.detail && <span className="detail">{s.detail}</span>}
                </summary>
                {(s.input !== undefined || s.output !== undefined) && (
                  <pre>
                    {s.input !== undefined ? `entrada: ${json(s.input)}\n` : ''}
                    {s.output !== undefined ? `saída: ${json(s.output)}` : ''}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </div>
      )}

      <div className="meta">
        <span>{trace.latencyMs} ms no total</span>
        {trace.model && <span>modelo {trace.model}</span>}
        {trace.usage && (
          <span>
            {trace.usage.inputTokens} tokens de entrada · {trace.usage.outputTokens} de saída
          </span>
        )}
        {!trace.usage && trace.interpreter !== 'llm' && <span>0 tokens</span>}
      </div>
    </section>
  );
}
