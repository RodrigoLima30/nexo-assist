/**
 * Limite de taxa em memória (janela deslizante). Suficiente para um processo único;
 * com várias instâncias, trocaria por Redis. Protege custo de LLM e abuso no deploy.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Registra uma tentativa; devolve false se a chave estourou o limite. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
