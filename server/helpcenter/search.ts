import { fold, tokens } from '../lib/text';
import { ARTICLES, type Article } from './articles';

export interface ArticleHit {
  article: Article;
  score: number;
}

/**
 * Busca lexical na central de ajuda: tokens com acento normalizado, peso maior para
 * palavras-chave do artigo e para expressões exatas (ex.: "erro 809"). Com 8 artigos,
 * busca vetorial seria exagero — e esta é determinística, barata e fácil de testar.
 */
export function searchArticles(query: string, limit = 3): ArticleHit[] {
  const q = fold(query);
  const qTokens = new Set(tokens(query));
  const hits: ArticleHit[] = [];
  for (const article of ARTICLES) {
    let score = 0;
    for (const kw of article.keywords) {
      if (kw.includes(' ') || kw.includes('-')) {
        if (q.includes(kw)) score += 3;
      } else if (qTokens.has(kw)) {
        score += 2;
      }
    }
    const titleTokens = tokens(article.title);
    for (const t of titleTokens) if (qTokens.has(t)) score += 1;
    if (score > 0) hits.push({ article, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Pontuação mínima para considerar que o artigo trata do assunto. */
export const STRONG_MATCH = 3;
