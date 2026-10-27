/** Log estruturado mínimo (uma linha JSON por evento) — fácil de filtrar e de mandar para um coletor. */
type Level = 'info' | 'warn' | 'error';

function write(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (process.env.VITEST) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...data });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    info: (msg: string, data?: Record<string, unknown>) => write('info', scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write('warn', scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write('error', scope, msg, data),
  };
}
