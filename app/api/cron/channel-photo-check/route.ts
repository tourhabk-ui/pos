/**
 * GET /api/cron/channel-photo-check — почему посты канала уходят без картинок.
 *
 * ── Повод 31.08 ────────────────────────────────────────────────────────────
 *
 * Владелец: «новости в тг канале без картинок это кринж». Обложка при этом
 * есть ВСЕГДА по построению: `resolveCoverImage` возвращает либо картинку
 * DashScope, либо детерминированный Pollinations, и `null` не возвращает
 * никогда. Значит картинка теряется не при выборе, а при отправке.
 *
 * Откат в текст `tgPostPhoto` честно записывает — `ai_actions_log`,
 * `action_type = 'channel_photo_fallback'`, с ответом Telegram и адресом
 * картинки. Запись есть с самого начала; ЧИТАТЬ её было нечем, и полтора
 * месяца вопрос «почему без картинок» решался догадками.
 *
 * Это тот же дефект, что у очереди полевых проверок: пишем и не читаем. Форма
 * без чтения — способ потерять сведения, а не собрать их.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ничего не публикует и не чинит: сорок тысяч подписчиков
 * канала не должны видеть диагностику.
 *
 * Три исхода (§4.0): картинки уходят · вот почему не уходят · спросить не
 * смог. Пустая таблица — НЕ «всё хорошо»: она значит и «откатов не было», и
 * «постов не было вовсе», и эти два состояния здесь различаются по числу
 * постов за тот же срок.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Типы записей об УДАЧНОЙ публикации — ими меряется знаменатель. */
const POST_TYPES = [
  'ai_news_posted',
  'travel_news_posted',
  'kuzmich_post',
  'kuzmich_tip',
  'kuzmich_safety_post',
];

interface FallbackRow {
  created_at: string;
  photo_url: string | null;
  error: string | null;
  outcome: string | null;
}

/**
 * Ответ Telegram — в горсть родов, чтобы считать, а не читать глазами.
 *
 * Роды выбраны по тому, ЧТО ЧИНИТЬ, а не по тексту ответа: недоступная
 * картинка, слишком долгая картинка и запрет боту лечатся в трёх разных
 * местах. Неузнанное остаётся неузнанным — сваливать его в «прочее» с
 * готовым советом значило бы выдать догадку за диагноз.
 */
function classify(error: string | null): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'причина не записана';
  if (e.includes('wrong file identifier') || e.includes('failed to get http url content')) {
    return 'Telegram не смог забрать картинку по адресу';
  }
  if (e.includes('timeout') || e.includes('timed out') || e.includes('etimedout')) {
    return 'картинка не отдалась вовремя';
  }
  if (e.includes('too big') || e.includes('photo_invalid_dimensions')) {
    return 'картинка не подошла по размеру';
  }
  if (e.includes('forbidden') || e.includes('not enough rights') || e.includes('chat not found')) {
    return 'боту не разрешено публиковать';
  }
  return `не разобрано: ${e.slice(0, 80)}`;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!process.env.CRON_SECRET || !timingSafeCompare(secret, process.env.CRON_SECRET)) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get('days') ?? 30) || 30));

  let rows: FallbackRow[];
  let posts: number;
  try {
    const [fb, pc] = await Promise.all([
      pool.query<FallbackRow>(
        `SELECT created_at::text AS created_at,
                metadata->>'photo_url' AS photo_url,
                metadata->>'error'     AS error,
                metadata->>'outcome'   AS outcome
           FROM ai_actions_log
          WHERE action_type = 'channel_photo_fallback'
            AND created_at > NOW() - ($1 || ' days')::interval
          ORDER BY created_at DESC
          LIMIT 200`,
        [String(days)],
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM ai_actions_log
          WHERE action_type = ANY($2::text[])
            AND created_at > NOW() - ($1 || ' days')::interval`,
        [String(days), POST_TYPES],
      ),
    ]);
    rows = fb.rows;
    posts = Number(pc.rows[0]?.n ?? 0);
  } catch (err) {
    // Отказ проверки — третий исход, и он не равен «откатов нет» (§4.0).
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[channel-photo-check] спросить журнал не смог:', msg);
    return NextResponse.json(
      { success: false, probe: 'channel_photo_check_v1', refused: msg },
      { status: 502 },
    );
  }

  const byReason: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const r of rows) {
    const reason = classify(r.error);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const o = r.outcome ?? 'не записан';
    byOutcome[o] = (byOutcome[o] ?? 0) + 1;
  }

  // Откат в текст — это пост БЕЗ картинки. Откат на запасное фото — пост с
  // картинкой, просто не с первой; в «без картинок» его считать нельзя.
  const textOnly = byOutcome['text_only'] ?? 0;

  return NextResponse.json({
    success: true,
    probe: 'channel_photo_check_v1',
    days,
    posts_in_period: posts,
    fallbacks_total: rows.length,
    posts_without_photo: textOnly,
    /**
     * Пусто и постов ноль — «канал молчал», пусто при постах — «картинки
     * уходили». Разные новости, и одним числом их не выразить.
     */
    verdict: rows.length === 0
      ? (posts === 0
          ? 'откатов нет, но и постов нет — канал молчал'
          : 'откатов нет: картинки уходили')
      : `без картинки ушло постов: ${textOnly} из ${posts || 'неизвестно скольких'}`,
    by_reason: byReason,
    by_outcome: byOutcome,
    recent: rows.slice(0, 20).map((r) => ({
      at: r.created_at,
      outcome: r.outcome,
      reason: classify(r.error),
      error: r.error,
      photo_url: r.photo_url,
    })),
  });
}
