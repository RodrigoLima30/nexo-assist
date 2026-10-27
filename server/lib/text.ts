/** Normalização de texto em pt-BR: minúsculas e sem acentos. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const STOPWORDS = new Set(
  'a o as os um uma uns umas de da do das dos em no na nos nas por para pra pro com sem e ou que se me meu minha meus minhas seu sua eu voce ele ela isso esse essa este esta ja nao sim mais muito como qual quais quando onde porque ao aos e esta estou tem ter tenho foi ser sao era desde hoje ontem agora'.split(
    ' ',
  ),
);

export function tokens(text: string): string[] {
  return fold(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Similaridade de Jaccard entre conjuntos de tokens. */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
