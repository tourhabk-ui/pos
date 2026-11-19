/**
 * GET /api/cron/kuzmich-review-batch?days=7&limit=40 — диалоги Кузьмича для
 * оценки проверяющим вместо судьи-модели. Bearer CRON_SECRET. Только читает.
 *
 * Слово владельца 19.11: «у судьи баланса нет возьми на себя его работу пока».
 * Судья (`lib/agents/managed/kuzmich-outcomes`) текст не хранит; оценить можно
 * только то, что лежит в базе: веб-чат (`chat_sessions` без виджета партнёра —
 * виджет оценке и раньше не отдавался) и журнал A2A (`a2a_dialogs`, только
 * завершённые). Telegram и MAX разговоров не хранят — их в выгрузке нет.
 *
 * Тексты — только шифром открытым ключом проверяющего из кода
 * (`lib/agents/review/reviewer-key`): ответ читает проверка прода, а её лог
 * открыт любому. В открытом виде — только числа. Ключ не записан или не
 * читается — 503 словами, текстов нет. Маска и шифр —
 * `lib/agents/review/review-batch`.
 *
 * Сторож: tests/unit/kuzmich-review-batch.test.ts; запросы на настоящей базе —
 * сцена в tests/integration/admin-day-counts.pg.test.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { REVIEWER_PUBLIC_KEY_PEM } from '@/lib/agents/review/reviewer-key';
import { buildReviewBatch, sealForReviewer, type A2aRow, type WebRow } from '@/lib/agents/review/review-batch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Веб-сессии за окно, свежие первыми; виджет партнёра — не сюда. */
export const REVIEW_WEB_SQL = `
  SELECT to_char((updated_at AT TIME ZONE 'Asia/Kamchatka')::date, 'YYYY-MM-DD') AS day,
         role, messages
    FROM chat_sessions
   WHERE updated_at > NOW() - ($1::int * INTERVAL '1 day')
     AND widget_origin IS NULL
   ORDER BY updated_at DESC
   LIMIT $2`;

/** Завершённые разговоры A2A за окно, свежие первыми. */
export const REVIEW_A2A_SQL = `
  SELECT to_char((created_at AT TIME ZONE 'Asia/Kamchatka')::date, 'YYYY-MM-DD') AS day,
         agent, is_self, question, answer
    FROM a2a_dialogs
   WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
     AND state = 'completed'
   ORDER BY created_at DESC
   LIMIT $2`;

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse({
    days: request.nextUrl.searchParams.get('days') ?? undefined,
    limit: request.nextUrl.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'days — от 1 до 30, limit — от 1 до 100' }, { status: 400 });
  }
  const { days, limit } = parsed.data;

  if (!REVIEWER_PUBLIC_KEY_PEM.trim()) {
    return NextResponse.json({ ok: false, error: 'ключ проверяющего не записан — тексты не отдаются' }, { status: 503 });
  }

  let web: WebRow[];
  let a2a: A2aRow[];
  try {
    const [w, a] = await Promise.all([
      pool.query<WebRow>(REVIEW_WEB_SQL, [days, limit]),
      pool.query<A2aRow>(REVIEW_A2A_SQL, [days, limit]),
    ]);
    web = w.rows;
    a2a = a.rows;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[kuzmich-review-batch] чтение не удалось:', typeof code === 'string' ? `SQLSTATE=${code}` : 'без SQLSTATE');
    return NextResponse.json(
      { ok: false, error: 'диалоги не прочитались', sqlstate: typeof code === 'string' ? code : null },
      { status: 502 },
    );
  }

  const batch = buildReviewBatch(web, a2a);
  let sealed;
  try {
    sealed = sealForReviewer(JSON.stringify(batch), REVIEWER_PUBLIC_KEY_PEM);
  } catch (err) {
    console.error('[kuzmich-review-batch] ключ проверяющего не читается:', err instanceof Error ? err.name : 'ошибка');
    return NextResponse.json({ ok: false, error: 'ключ проверяющего не читается — тексты не отдаются' }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    days,
    limit,
    web_sessions_read: web.length,
    web_dialogs: batch.web.length,
    web_pairs: batch.web.reduce((s, d) => s + d.pairs.length, 0),
    a2a_read: a2a.length,
    a2a_dialogs: batch.a2a.length,
    dropped_over_size: batch.dropped,
    sealed,
    caveats: [
      'Тексты — только в шифре открытым ключом проверяющего из lib/agents/review/reviewer-key; открытого текста в ответе нет.',
      'Маска redactChatPD: телефон, почта, ссылки, ники, имя в обороте «меня зовут…» и подпись. Имя вне этих оборотов и сведения о себе маска не узнаёт.',
      'Веб-чат хранит последние 20 реплик сессии без времени каждой: день — по последней реплике. Telegram и MAX разговоров не хранят.',
    ],
  });
}
