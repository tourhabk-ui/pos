/**
 * Семантический поиск — Google Gemini text-embedding-004 + in-memory cosine similarity.
 *
 * Модель: text-embedding-004 (768 dims, multilingual)
 * API: generativelanguage.googleapis.com — ~200ms, GEMINI_API_KEY
 * Хранение: JSONB массив float в agent_route_knowledge.embedding
 */

import { query } from '@/lib/database';
import { getGeminiKey } from '@/lib/ai/provider-config';

// ── Типы ──────────────────────────────────────────────────────

export interface SemanticSearchResult {
  id: string;
  title: string;
  description: string | null;
  category: string;
  sourceUrl: string | null;
  sourceName: string | null;
  lat: number | null;
  lng: number | null;
  similarity: number;
}

interface CachedRoute {
  id: string;
  title: string;
  description: string | null;
  category: string;
  sourceUrl: string | null;
  sourceName: string | null;
  lat: number | null;
  lng: number | null;
  embedding: number[];
}

const GEMINI_EMBED_DIM = 768;

// ── Генерация эмбеддинга через Gemini API ────────────────────

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = getGeminiKey();
  if (!apiKey) return [];

  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 2048);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: clean }] },
        }),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json() as { embedding?: { values?: number[] } };
    return data?.embedding?.values ?? [];
  } catch {
    return [];
  }
}

// ── No-op warmup (Gemini needs no pre-loading) ───────────────
export async function warmModel(): Promise<void> { /* no-op */ }

// ── In-memory cache маршрутов ─────────────────────────────────

let embeddingCache: CachedRoute[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadEmbeddingCache(): Promise<CachedRoute[]> {
  const now = Date.now();
  if (embeddingCache && now - cacheTimestamp < CACHE_TTL_MS) return embeddingCache;

  const result = await query<{
    id: string;
    title: string;
    description: string | null;
    category: string;
    source_url: string | null;
    source_name: string | null;
    lat: string | null;
    lng: string | null;
    embedding: number[];
  }>(
    `SELECT id, title, description, category, source_url, source_name, lat, lng, embedding
     FROM agent_route_knowledge
     WHERE embedding IS NOT NULL AND array_length(embedding, 1) = ${GEMINI_EMBED_DIM}`
  );

  embeddingCache = result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    lat: row.lat != null ? parseFloat(String(row.lat)) : null,
    lng: row.lng != null ? parseFloat(String(row.lng)) : null,
    embedding: row.embedding,
  }));

  cacheTimestamp = now;
  return embeddingCache;
}

export function invalidateCache(): void {
  embeddingCache = null;
  cacheTimestamp = 0;
}

// ── Cosine similarity ─────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ── Семантический поиск ───────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.6;

export async function semanticSearch(
  queryText: string,
  limit = 10,
): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await generateEmbedding(queryText);
  if (queryEmbedding.length === 0) return [];

  const cache = await loadEmbeddingCache();
  if (cache.length === 0) return [];

  const scored: (CachedRoute & { similarity: number })[] = [];
  for (const route of cache) {
    const sim = dotProduct(queryEmbedding, route.embedding);
    if (sim >= SIMILARITY_THRESHOLD) scored.push({ ...route, similarity: sim });
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    sourceUrl: r.sourceUrl,
    sourceName: r.sourceName,
    lat: r.lat,
    lng: r.lng,
    similarity: Math.round(r.similarity * 100) / 100,
  }));
}
