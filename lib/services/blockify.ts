/**
 * lib/services/blockify.ts
 *
 * Клиент Blockify API — конвертирует текст в IdeaBlocks для RAG Кузьмича.
 * Документация: https://github.com/iternal-technologies-partners/blockify-agentic-data-optimization
 *
 * Env: BLOCKIFY_API_KEY=blk_...
 */

const BLOCKIFY_API = 'https://api.blockify.ai/v1/chat/completions';
const CHUNK_SIZE   = 2000;  // символов на чанк (рекомендовано 1000-4000)
const CHUNK_OVERLAP = 200;

export interface IdeaBlock {
  id: string;           // ib_<sha256[:16]>
  name: string;
  criticalQuestion: string;
  trustedAnswer: string;
  tags: string[];
  keywords: string[];
  entityName: string | null;
  entityType: string | null;
}

function apiKey(): string | null {
  return process.env.BLOCKIFY_API_KEY ?? null;
}

// ── XML парсер IdeaBlocks ─────────────────────────────────────────────────────

export function parseIdeaBlocks(xml: string): IdeaBlock[] {
  const blocks: IdeaBlock[] = [];
  const blockRe = /<ideablock>([\s\S]*?)<\/ideablock>/gi;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(xml)) !== null) {
    const inner = m[1];

    const get = (tag: string) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
      return inner.match(r)?.[1]?.trim() ?? '';
    };

    const name             = get('name');
    const criticalQuestion = get('critical_question');
    const trustedAnswer    = get('trusted_answer');
    const tagsRaw          = get('tags');
    const keywordsRaw      = get('keywords');
    const entityName       = get('entity_name') || null;
    const entityType       = get('entity_type') || null;

    if (!name || !criticalQuestion || !trustedAnswer) continue;

    const tags     = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);

    // ID: ib_ + sha256 первых 16 hex (детерминированный по контенту)
    const raw = `${name}|${criticalQuestion}|${trustedAnswer}`;
    const id  = 'ib_' + simpleHash(raw);

    blocks.push({ id, name, criticalQuestion, trustedAnswer, tags, keywords, entityName, entityType });
  }

  return blocks;
}

function simpleHash(str: string): string {
  // Детерминированный хеш без crypto (runtime-safe)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (4294967296 * (2097151 & h2) + (h1 >>> 0)) >>> 0;
  return n.toString(16).padStart(16, '0');
}

// ── Чанкинг текста ────────────────────────────────────────────────────────────

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}

// ── API вызов: один чанк → IdeaBlocks ────────────────────────────────────────

export async function ingestChunk(text: string): Promise<IdeaBlock[]> {
  const key = apiKey();
  if (!key) throw new Error('BLOCKIFY_API_KEY not set');

  const res = await fetch(BLOCKIFY_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'ingest',
      messages: [{ role: 'user', content: text }],
      max_tokens: 8000,
      temperature: 0.5,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blockify API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: { message: { content: string } }[] };
  const xml  = data.choices[0]?.message?.content ?? '';
  return parseIdeaBlocks(xml);
}

// ── Полный ingest текста (авто-чанкинг + retry) ───────────────────────────────

export async function ingestText(
  text: string,
  opts: { chunkSize?: number; delayMs?: number } = {},
): Promise<IdeaBlock[]> {
  const { chunkSize = CHUNK_SIZE, delayMs = 2000 } = opts;
  const chunks = chunkText(text, chunkSize);
  const allBlocks: IdeaBlock[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && delayMs) await new Promise(r => setTimeout(r, delayMs));

    let attempts = 0;
    while (attempts < 3) {
      try {
        const blocks = await ingestChunk(chunks[i]);
        allBlocks.push(...blocks);
        break;
      } catch (e) {
        attempts++;
        if (attempts === 3) throw e;
        await new Promise(r => setTimeout(r, 2 ** attempts * 1000));
      }
    }
  }

  // Дедупликация по id
  return [...new Map(allBlocks.map(b => [b.id, b])).values()];
}

// ── Поиск по IdeaBlocks (full-text, без векторной БД) ────────────────────────

export interface BlockSearchResult {
  id: string;
  name: string;
  criticalQuestion: string;
  trustedAnswer: string;
  tags: string[];
  keywords: string[];
  sourceType: string;
  sourceId: string | null;
  rank: number;
}

/**
 * Ищет IdeaBlocks в PostgreSQL по запросу туриста.
 * Используется в Кузьмиче как основной RAG-источник.
 */
export async function searchIdeaBlocks(
  query: string,
  opts: { limit?: number; sourceType?: string } = {},
): Promise<BlockSearchResult[]> {
  const { limit = 5, sourceType } = opts;
  const { query: dbQuery } = await import('@/lib/database');

  const params: unknown[] = [query, limit];
  const typeFilter = sourceType ? `AND ib.source_type = $3` : '';
  if (sourceType) params.push(sourceType);

  const res = await dbQuery(
    `SELECT
       ib.id, ib.name, ib.critical_question, ib.trusted_answer,
       ib.tags, ib.keywords, ib.source_type, ib.source_id,
       ts_rank(ib.search_text, plainto_tsquery('russian', $1)) AS rank
     FROM ideablocks ib
     WHERE ib.search_text @@ plainto_tsquery('russian', $1)
       ${typeFilter}
     ORDER BY rank DESC
     LIMIT $2`,
    params,
  );

  return res.rows.map(r => ({
    id:               r.id as string,
    name:             r.name as string,
    criticalQuestion: r.critical_question as string,
    trustedAnswer:    r.trusted_answer as string,
    tags:             (r.tags as string[]) ?? [],
    keywords:         (r.keywords as string[]) ?? [],
    sourceType:       r.source_type as string,
    sourceId:         r.source_id as string | null,
    rank:             parseFloat(r.rank as string),
  }));
}

/**
 * Форматирует IdeaBlocks в контекст для промпта Кузьмича.
 */
export function formatBlocksForPrompt(blocks: BlockSearchResult[]): string {
  if (!blocks.length) return '';
  return blocks
    .map(b => `[${b.name}]\nВопрос: ${b.criticalQuestion}\nОтвет: ${b.trustedAnswer}`)
    .join('\n\n');
}
