import 'dotenv/config';
import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Variável ${name} inválida: "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');

/** Provedores com chave conhecida pelo model router do Mastra. */
const PROVIDER_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const model = process.env.NEXO_MODEL ?? 'anthropic/claude-haiku-5-5';
const provider = model.split('/')[0] ?? '';
const keyVar = PROVIDER_KEYS[provider];
const hasKey = keyVar ? Boolean(process.env[keyVar]) : false;

export const config = {
  appPort: num('APP_PORT', 4000),
  ticketsPort: num('TICKETS_PORT', 4100),
  ticketsServiceUrl: process.env.TICKETS_SERVICE_URL ?? 'http://localhost:4100',
  ticketsServiceToken: process.env.TICKETS_SERVICE_TOKEN ?? 'dev-token',
  ticketsFailureRate: num('TICKETS_FAILURE_RATE', 0.1),
  dataDir,
  appDbPath: path.join(dataDir, 'nexo.db'),
  ticketsDbPath: path.join(dataDir, 'tickets.db'),
  llm: {
    model,
    enabled: hasKey && !bool('NEXO_OFFLINE', false),
  },
  maxUserMessages: num('MAX_USER_MESSAGES_PER_CONVERSATION', 30),
  chatRateLimitPerMinute: num('CHAT_RATE_LIMIT_PER_MINUTE', 12),
  isProduction: process.env.NODE_ENV === 'production',
} as const;
