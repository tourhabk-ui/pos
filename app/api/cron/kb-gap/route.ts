/**
 * GET /api/cron/kb-gap
 *
 * Ежедневный анализ пробелов в знаниях Кузьмича.
 *
 * Алгоритм:
 *   1. Берёт chat_sessions за последние 48ч
 *   2. Находит разговоры где ответ бота содержит признаки незнания
 *   3. Извлекает вопросы пользователей из этих разговоров
 *   4. Для уникальных тем ищет в вебе (Tavily → Brave)
 *   5. Сохраняет в agent_knowledge для kuzmich
 *
 * Cron: запускать раз в сутки через cron-job.org
 * URL: /api/cron/kb-gap?secret=CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { redactPII } from '@/lib/security/pii-redact';

export const dynamic = 'force-dynamic';

const UNKNOWING_MARKERS = [
  'нет информации', 'не знаю', 'не знаком', 'не располагаю',
  'нет данных', 'у меня нет', 'не могу помочь', 'нет в моей базе',
];

const MAX_TOPICS_PER_RUN = 10;

interface SessionRow {
  session_id: string;
  messages: Array<{ role: string; content: string }>;
}

async function searchWebForKB(query: string): Promise<string> {
  const searchQ = /камчатк/i.test(query) ? query : `${query} Камчатка`;

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query: searchQ, search_depth: 'basic', max_results: 3 }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as { results?: Array<{ title: string; content: string }> };
        const snippets = (data.results ?? []).map(r => `${r.title}: ${r.content.slice(0, 400)}`);
        if (snippets.length > 0) return snippets.join('\n\n');
      }
    } catch { /* fallback */ }
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQ)}&count=3&country=ru`;
      const res = await fetch(url, { headers: { 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json() as { web?: { results?: Array<{ title: string; description: string }> } };
        const snippets = (data.web?.results ?? []).map(r => `${r.title}: ${r.description}`);
        if (snippets.length > 0) return snippets.join('\n\n');
      }
    } catch { /* nothing */ }
  }

  return '';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Найти сессии с признаками незнания в ответах бота
  const { rows: sessions } = await pool.query<SessionRow>(
    `SELECT session_id, messages
     FROM chat_sessions
     WHERE updated_at > $1
       AND messages IS NOT NULL
       AND jsonb_array_length(messages) > 1
     ORDER BY updated_at DESC
     LIMIT 200`,
    [since],
  );

  // Извлечь unanswered вопросы
  const unknownQuestions: string[] = [];

  for (const session of sessions) {
    const msgs = session.messages;
    for (let i = 0; i < msgs.length - 1; i++) {
      const userMsg = msgs[i];
      const botMsg = msgs[i + 1];
      if (userMsg?.role !== 'user' || botMsg?.role !== 'assistant') continue;

      const botText = botMsg.content?.toLowerCase() ?? '';
      const isUnknowing = UNKNOWING_MARKERS.some(m => botText.includes(m));
      if (isUnknowing && userMsg.content?.length > 5) {
        // Вопрос туриста дальше уходит в зарубежную модель (дедуп), в
        // веб-поиск и в заголовок записи — телефон и почта не идут никуда
        // (проверка MCP 29.09: заголовки auto_gap отдавались наружу).
        unknownQuestions.push(redactPII(userMsg.content).slice(0, 200));
      }
    }
  }

  if (unknownQuestions.length === 0) {
    return NextResponse.json({ success: true, message: 'Нет пробелов в знаниях', gaps_found: 0 });
  }

  // Дедупликация через AI-кластеризацию
  const dedupePrompt = `Вот список вопросов пользователей которые бот не смог ответить.
Оставь только уникальные темы (не больше ${MAX_TOPICS_PER_RUN}), убери дубликаты, сформулируй каждую тему как чёткий поисковый запрос.
Ответь JSON массивом строк: ["запрос1", "запрос2", ...]

Вопросы:
${unknownQuestions.slice(0, 50).map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

  let uniqueTopics: string[] = [];
  try {
    const raw = await callAIFast([
      { role: 'system', content: 'Ты помощник по анализу данных. Отвечай только валидным JSON.' },
      { role: 'user', content: dedupePrompt },
    ]);
    const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()) as unknown;
    if (Array.isArray(parsed)) uniqueTopics = (parsed as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_TOPICS_PER_RUN);
  } catch {
    uniqueTopics = [...new Set(unknownQuestions)].slice(0, MAX_TOPICS_PER_RUN);
  }

  // Для каждой темы: поиск → сохранение в agent_knowledge
  const saved: string[] = [];
  for (const topic of uniqueTopics) {
    const searchResult = await searchWebForKB(topic);
    if (!searchResult) continue;

    // AI-синтез — получаем краткий структурированный ответ
    let compiled = searchResult;
    try {
      const synthesis = await callAIFast([
        { role: 'system', content: 'Синтезируй найденные данные в краткий справочный ответ на русском (2-4 предложения). Без вводных слов.' },
        { role: 'user', content: `Тема: ${topic}\n\nДанные:\n${searchResult.slice(0, 1000)}` },
      ]);
      if (synthesis?.trim()) compiled = synthesis.trim();
    } catch { /* use raw search result */ }

    const slug = `gap_${topic.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '_').replace(/_+/g, '_').slice(0, 50)}_${Date.now() % 10000}`;

    // «Сохранено» считается по факту записи: прежний .catch(() => {}) с
    // безусловным saved.push отчитывался темами, которых в базе нет (§4.0).
    const stored = await pool.query(
      `INSERT INTO agent_knowledge(slug,type,title,compiled_truth,agent_id,edit_count,created_at,updated_at)
       VALUES($1,'auto_gap',$2,$3,'kuzmich',0,NOW(),NOW())
       ON CONFLICT(slug) DO NOTHING`,
      [slug, topic.slice(0, 100), `${compiled}\n[Авто, ${new Date().toLocaleDateString('ru-RU')}]`],
    ).then(() => true, (err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      console.error('[kb-gap] запись не сохранена:', typeof code === 'string' ? code : '', err instanceof Error ? err.message : String(err));
      return false;
    });

    if (stored) saved.push(topic);
  }

  return NextResponse.json({
    success: true,
    gaps_found: unknownQuestions.length,
    topics_processed: uniqueTopics.length,
    topics_saved: saved.length,
    // Сами темы наружу не отдаются: это вопросы туристов (при отказе дедупа —
    // дословно), а ответ крона печатается в лог GitHub Actions
    // (cron-kb-gap.yml, cat /tmp/out.json) — за пределы платформы (152-ФЗ,
    // проверка MCP 29.09). Темы видны в agent_knowledge.
    timestamp: new Date().toISOString(),
  });
}
