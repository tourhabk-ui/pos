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

import { callAIFast } from '@/lib/ai/providers';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { deduplicateBySimilarity } from '@/lib/utils/text-similarity';
import { readAgentBriefing } from '@/lib/agents/warmup';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface DigestResult {
  signals_found: number;
  digest_sent: boolean;
  duration_ms: number;
}

interface RssItem {
  title: string;
  url: string;
  source: string;
}

const RSS_SOURCES = [
  // AI & Tech
  { url: 'https://habr.com/ru/rss/hub/artificial_intelligence/all/?fl=ru', label: 'Habr AI' },
  { url: 'https://habr.com/ru/rss/hub/machine_learning/all/?fl=ru', label: 'Habr ML' },
  // Travel
  { url: 'https://www.rata-news.ru/rss', label: 'RATA' },
  { url: 'https://tourprom.ru/rss', label: 'Tourprom' },
  // Kamchatka
  { url: 'https://www.kamgov.ru/rss', label: 'Kamgov' },
];

async function fetchRssWithRetry(url: string, options: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

async function fetchRss(url: string, label: string): Promise<RssItem[]> {
  try {
    const res = await fetchRssWithRetry(url, {
      headers: { 'User-Agent': 'TourHab/1.0 (Scout Digest)' },
    });
    const xml = await res.text();
    const items: RssItem[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const block = match[1];
      const title = (/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i.exec(block)?.[1] ?? '').trim();
      const link = (/<link[^>]*>(.*?)<\/link>|<guid[^>]*>(https?[^<]+)<\/guid>/i.exec(block)?.[1] ?? '').trim();
      if (title && title.length > 5) {
        items.push({ title, url: link, source: label });
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function tgSendTo(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

export async function runScoutDigest(): Promise<DigestResult> {
  const start = Date.now();

  // Warm-up: read platform state and own run history before doing any work.
  // recentRuns tells the agent what it already processed so it avoids duplicates.
  const briefing = await readAgentBriefing('scout-digest');

  // Collect RSS in parallel
  const allItems: RssItem[] = [];
  const results = await Promise.allSettled(
    RSS_SOURCES.map(s => fetchRss(s.url, s.label))
  );
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value);
  }

  if (allItems.length === 0) {
    return { signals_found: 0, digest_sent: false, duration_ms: Date.now() - start };
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
    return { signals_found: 0, digest_sent: sent, duration_ms: Date.now() - start };
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

СТРОГИЕ ПРАВИЛА ФИЛЬТРАЦИИ:
- Раздел "Камчатка" — ТОЛЬКО материалы про Камчатский край. Любые другие регионы РФ (Татарстан, Сочи, Байкал, Алтай и т.д.) — игнорировать полностью, не упоминать даже как аналогию.
- Раздел "Туриндустрия" — только про туризм в РФ или глобальные тренды с применимостью к Камчатке. Локальные новости чужих регионов — пропускать.
- Раздел "AI & Tech" — только технологии с реальной применимостью к туристической платформе. Абстрактные AI-эксперименты без связи с туризмом — пропускать.
- Если по какому-то разделу нет релевантных сигналов — написать "Нет значимых сигналов за сегодня" вместо высасывания нерелевантного контента.

Формат ответа — только HTML для Telegram, без markdown:
<b>Дайджест [дата]</b>

<b>AI & Tech</b>
- [краткий инсайт 1-2 предложения, что это значит для платформы]

<b>Туриндустрия</b>
- [краткий инсайт]

<b>Камчатка</b>
- [краткий инсайт про Камчатский край]

Пиши по-русски. Только факты и их применимость к TourHab. Без воды. Лучше меньше инсайтов но все релевантные, чем много но мусорных.`,
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
    return { signals_found: freshItems.length, digest_sent: false, duration_ms: Date.now() - start };
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
    const aiItems = dedupedItems.filter(i => i.source === 'Habr AI' || i.source === 'Habr ML');
    if (aiItems.length > 0) {
      const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      const aiSignals = aiItems
        .map(i => `[${i.source}] ${i.title}${i.url ? `\nURL: ${i.url}` : ''}`)
        .join('\n\n');
      const aiMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `Ты редактор Telegram-канала о вайб-кодинге и AI-разработке (40К подписчиков).
Читатели — разработчики, следящие за Claude, Cursor, Grok, Copilot, Windsurf.

Из RSS-сигналов Habr выдели 2-3 главных инсайта для AI-разработчика.
Фокус: новые модели, обновления инструментов, промпт-хаки, вайб-кодинг, агенты.

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ — только Telegram HTML, строго эта структура:

<b>AI-дайджест · ${today}</b>

<b>[Заголовок первого инсайта — 5-8 слов]</b>
[2-3 предложения: суть + что это даёт разработчику. Конкретно: версии, цифры, инструменты.]
<a href="[URL статьи если есть]">Читать на Habr →</a>

<blockquote expandable>[Дополнительный контекст или нюанс — 1-2 предложения. Что это меняет в практике.]</blockquote>

<b>[Заголовок второго инсайта]</b>
[2-3 предложения]
<a href="[URL если есть]">Читать →</a>

<b>[Заголовок третьего инсайта если есть]</b>
[2-3 предложения]

<i>Источник: Habr AI/ML</i>

ПРАВИЛА:
- Включай <a href="URL"> только если URL реально был в сигнале
- Без буллитов (•) и нумерации
- Без слов "инсайт", "важно", "интересно" — только суть
- Пиши по-русски, профессионально, без воды`,
        },
        {
          role: 'user',
          content: `Сигналы:\n\n${aiSignals}`,
        },
      ];
      const aiDigest = await callAIFast(aiMessages).catch(() => null);
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
      metadata: { signals: dedupedItems.length, raw_signals: allItems.length, fresh_signals: freshItems.length, sources: RSS_SOURCES.map(s => s.label), sent_to_tg: sent },
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

  return { signals_found: dedupedItems.length, digest_sent: sent, duration_ms: Date.now() - start };
}
