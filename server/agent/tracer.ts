import { randomUUID } from 'node:crypto';
import type { TraceStep } from '@shared/chat';

/**
 * Registra cada passo do agent (ferramenta usada, duração, entrada/saída resumidas).
 * Os passos são transmitidos em tempo real para a interface e guardados na trilha.
 */
export class Tracer {
  readonly steps: TraceStep[] = [];

  constructor(private readonly onStep?: (step: TraceStep) => void) {}

  async run<T>(
    label: string,
    tool: string,
    fn: () => Promise<T>,
    opts: { visible?: boolean; input?: unknown; summarize?: (result: T) => { detail?: string; output?: unknown } } = {},
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await fn();
      const summary = opts.summarize?.(result) ?? {};
      this.push({
        id: randomUUID(),
        label,
        tool,
        status: 'ok',
        detail: summary.detail ?? null,
        durationMs: Math.round(performance.now() - started),
        visible: opts.visible ?? true,
        input: opts.input,
        output: summary.output,
      });
      return result;
    } catch (err) {
      this.push({
        id: randomUUID(),
        label,
        tool,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - started),
        visible: true,
        input: opts.input,
      });
      throw err;
    }
  }

  /** Passo síncrono e determinístico (regra aplicada, rascunho montado). */
  note(label: string, tool: string, detail: string, extra: { input?: unknown; output?: unknown; visible?: boolean } = {}): void {
    this.push({
      id: randomUUID(),
      label,
      tool,
      status: 'ok',
      detail,
      durationMs: 0,
      visible: extra.visible ?? true,
      input: extra.input,
      output: extra.output,
    });
  }

  /** Torna visível um passo de contexto que acabou sendo usado na decisão. */
  reveal(tool: string): void {
    const step = this.steps.find((s) => s.tool === tool && !s.visible);
    if (step) {
      step.visible = true;
      this.onStep?.(step);
    }
  }

  private push(step: TraceStep): void {
    this.steps.push(step);
    if (step.visible) this.onStep?.(step);
  }
}
