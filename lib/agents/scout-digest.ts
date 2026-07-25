/**
 * lib/agents/scout-digest.ts
 *
 * Scout Digest — ежедневный разведывательный дайджест.
 * Запускается раз в сутки через /api/cron/scout-digest.
 *
 * Собирает RSS-сигналы из 3 областей:
 *   1. AI & Tech — что нового в AI для применения к платформе
 *   2. Travel Industry — новости туриндустрии РФ
 *   3. Камчатка — конкуренты, спрос, события
 *
 * Синтезирует через AI → отправляет дайджест в Telegram.
 * Хранит результат в agent_memory для истории.
 */

import { callAIFast, fetchWithRetry } from '@/lib/ai/providers';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { deduplicateBySimilarity } from '@/lib/utils/text-similarity';
import { readAgentBriefing } from '@/lib/agents/warmup';
import { firecrawlScrape, firecrawlAvailable } from '@/lib/services/ingest/firecrawl';
import {
  SCOUT_SOURCE_EXPECTATIONS, applyRun, mapToRows, markAlertedInMap,
  evaluateDeadSources, dueForAlert, formatScoutDeadSources,
  type ScoutHealthMap, type SourceHealthEntry, type SourceStatus,
} from '@/lib/services/scout/source-health';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface DigestResult {
  signals_found: number;
  digest_sent: boolean;
  duration_ms: number;
  /** Здоровье источников за прогон: сколько живых из всех и какие молчат. */
  sources_ok?: number;
  sources_total?: number;
  dead_sources?: string[];
}

interface RssItem {
  title: string;
  url: string;
  source: string;
}

const RSS_SOURCES: Array<{ key: string; url: string; label: string; category: 'ai' | 'travel' | 'kamchatka' }> = [
  // AI & Tech — фронтир (англоязычные практические источники для тех, кто строит с LLM/агентами)
  { key: 'simonwillison', url: 'https://simonwillison.net/atom/everything/', label: 'Simon Willison', category: 'ai' },
  { key: 'huggingface',   url: 'https://huggingface.co/blog/feed.xml',       label: 'Hugging Face',   category: 'ai' },
  { key: 'marktechpost',  url: 'https://www.marktechpost.com/feed/',         label: 'MarkTechPost',   category: 'ai' },
  { key: 'hackernews',    url: 'https://hnrss.org/newest?q=LLM+OR+agent+OR+Claude+OR+Cursor', label: 'Hacker News', category: 'ai' },
  // AI & Tech — русский слой
  { key: 'habr_ai',       url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', label: 'Habr AI', category: 'ai' },
  // Travel
  { key: 'rata',          url: 'https://www.rata-news.ru/rss', label: 'RATA',     category: 'travel' },
  { key: 'tourprom',      url: 'https://tourprom.ru/rss',      label: 'Tourprom', category: 'travel' },
  // Kamchatka
  { key: 'kamgov',        url: 'https://www.kamgov.ru/rss',    label: 'Kamgov',        category: 'kamchatka' },
  { key: 'mchs_rss',      url: 'https://41.mchs.gov.ru/rss',   label: 'МЧС Камчатка',  category: 'kamchatka' },
];

// Метки AI-источников — для отдельного поста в @ai_hub_money
const AI_LABELS = new Set(RSS_SOURCES.filter(s => s.category === 'ai').map(s => s.label));

// Общий ретрай-хелпер с backoff+jitter (Roitman §18.7.1) — переиспользуем
// вместо локальной реализации без jitter, которая ретраила ЛЮБую ошибку
// (включая собственный таймаут); теперь таймаут фида не ретраится (это
// не транзиентный сбой, а исчерпанный бюджет времени на медленный источник).
async function fetchRssWithRetry(url: string, options: RequestInit, label: string): Promise<Response> {
  return fetchWithRetry(url, options, { timeoutMs: 8000, maxRetries: 2, baseDelayMs: 1000, label: `rss:${label}` });
}

/** Разбор RSS/Atom в items (чистая, без сети). */
function parseRssItems(xml: string, label: string): RssItem[] {
  const items: RssItem[] = [];
  // RSS использует <item>, Atom (напр. Simon Willison) — <entry>. Поддерживаем оба.
  const blockRegex = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRegex.exec(xml)) !== null && items.length < 5) {
    const block = match[2];
    const title = (
      /<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)
        ?.slice(1).find(Boolean) ?? ''
    ).trim();
    // RSS: <link>URL</link> | Atom: <link href="URL"/> | fallback: <guid>
    const link = (
      /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1]      // Atom
      ?? /<link[^>]*>(https?[^<]+)<\/link>/i.exec(block)?.[1]   // RSS
      ?? /<guid[^>]*>(https?[^<]+)<\/guid>/i.exec(block)?.[1]   // fallback
      ?? ''
    ).trim();
    if (title && title.length > 5) {
      items.push({ title, url: link, source: label });
    }
  }
  return items;
}

interface SourceFetch {
  key: string;
  label: string;
  category: 'ai' | 'travel' | 'kamchatka';
  items: RssItem[];
  /** Честный исход: 'ok' (фид отдал items), 'empty' (0 items), 'error' (упал/не-200). */
  status: SourceStatus;
}

/**
 * Тянет один источник и КЛАССИФИЦИРУЕТ исход — чтобы «нет сигналов» перестало
 * быть немым: видно, фид отдал материал, отдал пусто или упал. Раньше упавший
 * фид молча давал [] и был неотличим от «сегодня тихо».
 */
async function fetchSource(s: { key: string; url: string; label: string; category: 'ai' | 'travel' | 'kamchatka' }): Promise<SourceFetch> {
  try {
    const res = await fetchRssWithRetry(s.url, {
      headers: { 'User-Agent': 'TourHab/1.0 (Scout Digest)' },
    }, s.label);
    if (!res.ok) {
      return { key: s.key, label: s.label, category: s.category, items: [], status: 'error' };
    }
    const xml = await res.text();
    const items = parseRssItems(xml, s.label);
    return { key: s.key, label: s.label, category: s.category, items, status: items.length > 0 ? 'ok' : 'empty' };
  } catch {
    return { key: s.key, label: s.label, category: s.category, items: [], status: 'error' };
  }
}

async function tgSendTo(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    return (data as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function tgSendRich(
  chatId: string,
  text: string,
  buttons?: Array<Array<{ text: string; url: string }>>,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };
    if (buttons?.length) body.reply_markup = { inline_keyboard: buttons };
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return (data as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function tgSend(text: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;
  return tgSendTo(chatId, text);
}

interface SeenEntry { u: string; t: number }
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Фактчек-гейт: возвращает проценты из текста поста, которых НЕТ в исходных сигналах.
 * Процент считается выдуманным, если ни одно из его чисел не встречается в источнике.
 * Так как в AI-пост подаются только заголовки, любой неподтверждённый процент — галлюцинация.
 */
export function unsourcedPercents(post: string, source: string): string[] {
  const claims = post.match(/\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%/g) ?? [];
  const srcNums = new Set((source.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => n.replace(',', '.')));
  return claims.filter(claim => {
    const nums = claim.match(/\d+(?:[.,]\d+)?/g) ?? [];
    return !nums.some(n => srcNums.has(n.replace(',', '.')));
  });
}

/**
 * Тянет текст статьи для фактчека: Firecrawl (если ключ) → обычный fetch + грубое
 * извлечение текста из HTML. Возвращает '' при неудаче (тогда модель опирается на заголовок).
 */
async function fetchArticleText(url: string): Promise<string> {
  if (!url) return '';
  if (firecrawlAvailable()) {
    try {
      const page = await firecrawlScrape(url);
      if (page?.markdown) return page.markdown.slice(0, 2500);
    } catch { /* fallthrough */ }
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TourHab/1.0 Scout)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);
  } catch { return ''; }
}

/**
 * Семантический фактчек: AI сверяет проверяемые факты поста с источниками.
 * Возвращает список неподтверждённых/противоречащих утверждений (только факты, не оценки).
 */
async function unsupportedClaims(post: string, sources: string): Promise<string[]> {
  try {
    const raw = await callAIFast([
      { role: 'system', content: 'Ты строгий фактчекер. Сверь ПРОВЕРЯЕМЫЕ факты поста (цифры, проценты, версии, названия фич/моделей, технический механизм) с источниками. Оценочные суждения и takeaway («это полезно инженеру») НЕ проверяй. Верни ТОЛЬКО JSON: {"unsupported":["конкретное фактическое утверждение, которого нет в источниках или которое им противоречит"]}. Если все факты подтверждены — {"unsupported":[]}.' },
      { role: 'user', content: `ИСТОЧНИКИ:\n${sources.slice(0, 9000)}\n\nПОСТ:\n${post}` },
    ]);
    const m = raw?.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as { unsupported?: unknown };
    return Array.isArray(parsed.unsupported) ? parsed.unsupported.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * Учитывает здоровье источников за прогон, персистит в agent_memory и алертит
 * про молчащие фиды (дебаунс). Переиспользует детерминированный evaluateDeadSources
 * из safety. Не критично для дайджеста — ошибки глотаем.
 */
async function recordSourceHealthAndAlert(
  fetched: SourceFetch[],
): Promise<{ sources_ok: number; sources_total: number; dead_sources: string[] }> {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const entries: SourceHealthEntry[] = fetched.map(f => ({
    key: f.key, label: f.label, status: f.status, rawItems: f.items.length, inserted: 0,
  }));

  let deadLabels: string[] = [];
  try {
    const stored = await agentMemory.recall('scout-digest', 'source_health', 1).catch(() => []);
    const prevMap = ((stored[0]?.value as { map?: ScoutHealthMap } | undefined)?.map) ?? {};
    let map = applyRun(prevMap, entries, nowIso);

    const rows = mapToRows(map);
    const dead = evaluateDeadSources(rows, SCOUT_SOURCE_EXPECTATIONS, nowMs);
    deadLabels = dead.map(d => d.label);

    const toAlert = dueForAlert(dead, rows, nowMs);
    if (toAlert.length > 0) {
      await tgSend(formatScoutDeadSources(toAlert));
      map = markAlertedInMap(map, toAlert.map(d => d.key), nowIso);
    }

    await agentMemory.remember({
      agent_id: 'scout-digest',
      memory_type: 'source_health',
      key: 'sources',
      value: { map } as unknown as Record<string, unknown>,
      source: 'scout_digest_cron',
      expires_at: new Date(nowMs + 90 * 24 * 60 * 60 * 1000),
    });
  } catch {
    // health — вспомогательное, не роняем дайджест
  }

  return {
    sources_ok: entries.filter(e => e.status === 'ok').length,
    sources_total: entries.length,
    dead_sources: deadLabels,
  };
}

export async function runScoutDigest(): Promise<DigestResult> {
  const start = Date.now();

  // Warm-up: read platform state and own run history before doing any work.
  // recentRuns tells the agent what it already processed so it avoids duplicates.
  const briefing = await readAgentBriefing('scout-digest');

  // Collect RSS in parallel — с честным статусом каждого источника
  const fetched = await Promise.all(RSS_SOURCES.map(fetchSource));
  const allItems: RssItem[] = [];
  for (const f of fetched) allItems.push(...f.items);

  // Здоровье источников: делает «нет сигналов» диагностируемым (живой фид без
  // новостей vs мёртвый фид) и алертит про молчащие. До любых ранних выходов.
  const health = await recordSourceHealthAndAlert(fetched);

  if (allItems.length === 0) {
    return { signals_found: 0, digest_sent: false, duration_ms: Date.now() - start, ...health };
  }

  // Cross-run dedup: filter URLs already seen in the last 30 days
  const now = Date.now();
  const seenRaw = await agentMemory.recall('scout-digest', 'seen_urls', 1);
  const storedEntries: SeenEntry[] = (seenRaw[0]?.value as { urls?: SeenEntry[] } | undefined)?.urls ?? [];
  const activeEntries = storedEntries.filter(e => now - e.t < THIRTY_DAYS_MS);
  const seenSet = new Set(activeEntries.map(e => e.u));

  const freshItems = allItems.filter(item => {
    const key = item.url || item.title;
    return key && !seenSet.has(key);
  });

  if (freshItems.length === 0) {
    const sent = await tgSend(
      `<b>Дайджест ${new Date().toLocaleDateString('ru-RU')}</b>\n\nНовых сигналов за сутки нет. Мониторинг продолжается.`,
    );
    return { signals_found: 0, digest_sent: sent, duration_ms: Date.now() - start, ...health };
  }

  // Дедупликация: одна история из нескольких источников → одна запись
  const dedupedItems = deduplicateBySimilarity(freshItems, i => i.title, 0.5);

  // AI synthesis
  const signalsList = dedupedItems
    .map(i => `[${i.source}] ${i.title}`)
    .join('\n');

  // Build context section from briefing so AI knows current state and prior runs.
  const contextSection = [
    briefing.platformSummary ? `=== ТЕКУЩЕЕ СОСТОЯНИЕ ПЛАТФОРМЫ ===\n${briefing.platformSummary}` : '',
    briefing.recentRuns ? `=== МОИ ПОСЛЕДНИЕ ЗАПУСКИ (не дублировать уже выданные инсайты) ===\n${briefing.recentRuns}` : '',
  ].filter(Boolean).join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты разведчик туристической платформы TourHab (Камчатка).
Твоя задача — прочитать сигналы из RSS-лент и выделить 3-5 наиболее важных инсайтов.

ПРАВИЛА ВКЛЮЧЕНИЯ (широкие — лучше включить лишнее, чем потерять нужное):
- Раздел "AI & Tech" — любые новые модели, инструменты, агенты, обновления Claude/GPT/Gemini/Cursor, автоматизация, веб-разработка. Мы активно используем AI в разработке — даже косвенно полезное включай.
- Раздел "Туриндустрия" — туризм в РФ и мире, онлайн-бронирование, OTA, CRM для туроператоров, новые тренды. Другие регионы — допустимы как контекст или аналогия.
- Раздел "Камчатка" — ЛЮБЫЕ новости о Камчатском крае: туризм, экология, транспорт, инфраструктура, погода, безопасность. Мы обслуживаем туристов на Камчатке — любой контекст о регионе ценен.
- "Нет значимых сигналов за сегодня" — ТОЛЬКО если в разделе буквально ноль материалов. Если есть хоть что-то — пиши.

НЕ ВРАТЬ. Пиши только то, что есть в сигналах:
- Цифры, цены, версии, названия фич и технический механизм — ДОСЛОВНО из сигнала. Нет в сигнале — не пиши.
- Особенно про цены и тарифы: "без изменения цены", "дешевле", "бесплатно" — только если это сказано в сигнале. Не выводи из общих соображений.
- Если известен только заголовок — пиши общо, что появилось, без выдуманной конкретики.
- Лучше скромный честный пункт, чем эффектный с выдумкой. Выдуманный факт = провал.

Связь с платформой добавляй, ТОЛЬКО если она настоящая и конкретная.
Натянутая привязка ("может быть полезно для рекомендаций в туризме") хуже её
отсутствия: она ничего не сообщает и обесценивает остальной текст. Нет связи —
просто скажи, что произошло.

Пустых обещаний не давать: "стоит следить за обновлениями", "может изменить
рынок" — это не инсайт. Либо конкретика из сигнала, либо пункт не нужен.

Формат ответа — только HTML для Telegram, без markdown:
<b>Дайджест [дата]</b>

<b>AI & Tech</b>
- [что произошло, конкретика из сигнала]

<b>Туриндустрия</b>
- [краткий инсайт]

<b>Камчатка</b>
- [краткий инсайт про Камчатский край]

Пиши по-русски. Кратко и по делу. Без воды.`,
    },
    {
      role: 'user',
      content: `${contextSection ? contextSection + '\n\n' : ''}Сигналы за ${new Date().toLocaleDateString('ru-RU')}:\n\n${signalsList}`,
    },
  ];

  let digest: string | null = null;
  try {
    digest = await callAIFast(messages);
  } catch {
    digest = null;
  }

  if (!digest) {
    return { signals_found: freshItems.length, digest_sent: false, duration_ms: Date.now() - start, ...health };
  }

  // Все разделы пусты — НЕ публикуем. Раньше здесь всё равно шёл tgSend, и в
  // канал уходил дайджест из трёх строк «Нет значимых сигналов за сегодня».
  // Сообщение «сегодня новостей нет» не стоит публикации: оно ничего не несёт
  // и приучает пролистывать. seen_urls тоже не трогаем — вернёмся завтра.
  const allEmpty = (digest.match(/Нет значимых сигналов за сегодня/g) ?? []).length >= 3;
  if (allEmpty) {
    return { signals_found: 0, digest_sent: false, duration_ms: Date.now() - start, ...health };
  }

  // ── Фактчек основного дайджеста ────────────────────────────────────────────
  // Те же два гейта, что давно стоят на посте в AI-канал. Здесь их не было — и
  // 25.07.2026 в дайджест ушло «Claude Opus 5 — без изменения цены», хотя цена
  // изменилась вдвое. Модель не врала злонамеренно: ей просто не запретили
  // додумывать, и никто не сверял результат с источником.
  {
    let bad = unsourcedPercents(digest, signalsList);
    if (bad.length > 0) {
      const fix: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: digest },
        { role: 'user', content: `В тексте есть проценты, которых НЕТ в сигналах: ${bad.join(', ')}. Перепиши дайджест, убрав все неподтверждённые числа (формулируй без них). Верни только исправленный текст.` },
      ];
      const retry = await callAIFast(fix).catch(() => null);
      if (retry) { digest = retry; bad = unsourcedPercents(digest, signalsList); }
    }
    if (bad.length > 0) {
      return { signals_found: freshItems.length, digest_sent: false, duration_ms: Date.now() - start, ...health };
    }

    let claims = await unsupportedClaims(digest, signalsList);
    if (claims.length > 0) {
      const fix: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: digest },
        { role: 'user', content: `Эти утверждения НЕ подтверждаются сигналами (выдумка или искажение): ${claims.join(' | ')}. Перепиши дайджест строго по источникам, не добавляя новых непроверенных фактов. Верни только исправленный текст.` },
      ];
      const retry = await callAIFast(fix).catch(() => null);
      if (retry) { digest = retry; claims = await unsupportedClaims(digest, signalsList); }
    }
    if (claims.length > 0) {
      // Лучше не выпустить дайджест, чем выпустить с выдумкой.
      return { signals_found: freshItems.length, digest_sent: false, duration_ms: Date.now() - start, ...health };
    }
  }

  // Mark URLs as seen AFTER successful AI synthesis (don't mark if AI failed)
  const updatedEntries = [
    ...activeEntries,
    ...freshItems.map(i => ({ u: i.url || i.title, t: now })),
  ].slice(-1000);
  await agentMemory.remember({
    agent_id: 'scout-digest',
    memory_type: 'seen_urls',
    key: 'url_set',
    value: { urls: updatedEntries } as unknown as Record<string, unknown>,
    source: 'scout_digest_cron',
    expires_at: new Date(now + 60 * 24 * 60 * 60 * 1000), // renew 60d; internal filter handles 30d per-entry
  });

  const sent = await tgSend(digest);

  // Post AI & Tech section only to the AI channel (@ai_hub_money — vibe-coding, 40K subs)
  const aiChannelId = process.env.TELEGRAM_AI_CHANNEL_ID;
  if (aiChannelId) {
    const aiItems = dedupedItems.filter(i => AI_LABELS.has(i.source));
    if (aiItems.length > 0) {
      const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      // Тянем текст статей (фон, cron) — чтобы модель опиралась на содержание, а не на заголовок
      const aiTop = aiItems.slice(0, 3);
      const withText = await Promise.all(
        aiTop.map(async i => ({ ...i, text: await fetchArticleText(i.url) })),
      );
      const aiSignals = withText
        .map(i => `[${i.source}] ${i.title}\nURL: ${i.url}\nТЕКСТ СТАТЬИ:\n${i.text || '(текст недоступен — опирайся ТОЛЬКО на заголовок, без выдуманных деталей)'}`)
        .join('\n\n---\n\n');
      const aiMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `Ты практикующий AI-инженер и редактор Telegram-канала о вайб-кодинге (40К подписчиков).
Читатели САМИ строят с LLM и агентами: Claude Code, Cursor, LangGraph, MCP, локальные модели. Им нужен сигнал «что попробовать сегодня» и почему это меняет их работу.

ГЛАВНОЕ ПРАВИЛО — НЕ ВРАТЬ. Тебе даны выдержки статей. Опирайся ТОЛЬКО на них:
- Цифры, проценты, версии, названия фич, технический механизм бери ДОСЛОВНО из текста статьи. Нет в тексте — не пиши.
- НЕ переноси цифру с одного инструмента на другой. НЕ обобщай чужие бенчмарки.
- Если у материала текст недоступен (только заголовок) — пиши общо «что появилось и зачем», без выдуманной конкретики.
- Лучше скромный честный пост, чем эффектный с выдумкой. Выдуманный факт = провал.

Из материалов выбери 2-3 САМЫХ СИЛЬНЫХ. Вводное и вторичное — выбрасывай.

Для каждого:
- что появилось (по тексту статьи, дословная конкретика)
- <b>Почему важно:</b> практический takeaway (это твоя оценка-вывод, она допустима; факты-цифры — только из статьи)

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ — только Telegram HTML:

<b>AI-дайджест · ${today}</b>

<b>[Цепляющий заголовок — суть в 5-8 слов]</b>
[2 предложения: что сделали, конкретика — версии/цифры/инструмент]
<b>Почему важно:</b> [1-2 предложения: практический вывод для строителя агентов]
<a href="URL">Читать →</a>

<b>[Второй заголовок]</b>
[2 предложения конкретики]
<b>Почему важно:</b> [практический вывод]
<a href="URL">Читать →</a>

<blockquote expandable>[Необязательный третий материал или глубокий нюанс — что меняется в практике]</blockquote>

ПРАВИЛА:
- <a href="URL"> только если URL реально был в сигнале
- Без буллитов (•) и нумерации, без «интересно/важно отметить»
- Технический, уверенный тон. Как пишет инженер инженерам, а не SMM
- Пиши по-русски (даже если источник английский — синтезируй русский инсайт)`,
        },
        {
          role: 'user',
          content: `Сигналы:\n\n${aiSignals}`,
        },
      ];
      let aiDigest = await callAIFast(aiMessages).catch(() => null);

      // ── Фактчек-гейт: проценты в посте должны быть в исходных заголовках ──
      // У модели только заголовки, поэтому любой процент, которого нет в источнике, — выдумка.
      if (aiDigest) {
        let bad = unsourcedPercents(aiDigest, aiSignals);
        if (bad.length > 0) {
          // одна попытка переписать без неподтверждённых цифр
          const fix: ChatMessage[] = [
            ...aiMessages,
            { role: 'assistant', content: aiDigest },
            { role: 'user', content: `В тексте есть проценты, которых НЕТ в исходных заголовках: ${bad.join(', ')}. Это запрещено. Перепиши пост, полностью убрав все цифры и проценты, не подтверждённые заголовками (формулируй без чисел). Верни только исправленный пост.` },
          ];
          const retry = await callAIFast(fix).catch(() => null);
          if (retry) { aiDigest = retry; bad = unsourcedPercents(aiDigest, aiSignals); }
        }
        if (bad.length > 0) {
          // Числовой фактчек не пройден — НЕ публикуем (лучше не запостить, чем соврать).
          aiDigest = null;
        }
      }

      // ── Семантический фактчек: сверяем факты поста с текстом статей ──
      if (aiDigest) {
        let claims = await unsupportedClaims(aiDigest, aiSignals);
        if (claims.length > 0) {
          const fix: ChatMessage[] = [
            ...aiMessages,
            { role: 'assistant', content: aiDigest },
            { role: 'user', content: `Эти утверждения НЕ подтверждаются текстом статей (выдумка или искажение): ${claims.join(' | ')}. Перепиши пост, убрав или исправив их строго по источникам. Не добавляй новых непроверенных фактов. Верни только исправленный пост.` },
          ];
          const retry = await callAIFast(fix).catch(() => null);
          if (retry) { aiDigest = retry; claims = await unsupportedClaims(aiDigest, aiSignals); }
        }
        if (claims.length > 0) {
          // После переписи факты всё ещё не сходятся — не публикуем.
          aiDigest = null;
        }
      }

      if (aiDigest) {
        const buttons = aiItems
          .filter(i => i.url)
          .slice(0, 3)
          .map(i => [{ text: i.title.slice(0, 45) + (i.title.length > 45 ? '…' : ''), url: i.url }]);
        await tgSendRich(aiChannelId, aiDigest, buttons.length > 0 ? buttons : undefined);
      }
    }
  }

  // Store permanently in knowledge brain
  try {
    const dateKey = new Date().toISOString().slice(0, 10);
    const slug = `intel/scout/${dateKey}`;
    await knowledgeBase.upsert({
      slug,
      type: 'intel',
      title: `Scout Digest ${dateKey}`,
      compiled_truth: digest,
      metadata: {
        signals: dedupedItems.length, raw_signals: allItems.length, fresh_signals: freshItems.length,
        sources: RSS_SOURCES.map(s => s.label),
        // Честный per-source статус: какой фид отдал материал, а какой молчит/упал.
        source_health: fetched.map(f => ({ label: f.label, category: f.category, status: f.status, items: f.items.length })),
        dead_sources: health.dead_sources,
        sent_to_tg: sent,
      },
      agent_id: 'scout',
    });
    // Also keep short-term memory for agents that scan recent intel
    await agentMemory.remember({
      agent_id: 'evo',
      memory_type: 'intelligence',
      key: `scout_digest_${dateKey}`,
      value: { slug, signals: freshItems.length, sources: RSS_SOURCES.map(s => s.label) },
      confidence: 0.8,
      source: 'scout_digest_cron',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });
  } catch {
    // Non-critical
  }

  return { signals_found: dedupedItems.length, digest_sent: sent, duration_ms: Date.now() - start, ...health };
}
