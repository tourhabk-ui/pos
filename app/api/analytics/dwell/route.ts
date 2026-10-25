/**
 * POST /api/analytics/dwell
 * Доклад времени, проведённого на странице. Клиент шлёт его через sendBeacon
 * в момент ухода (переход, сворачивание вкладки, закрытие) — обычный fetch там
 * уже не доживает.
 *
 * Отдельный эндпоинт, а не поле в /hit, потому что время известно ПОСЛЕ
 * просмотра: одна строка на просмотр, дописывается один раз.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { ENGAGED_DWELL_MS } from '@/lib/analytics/address-burst';

const DwellSchema = z.object({
  id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
  // Верхняя граница 6 часов: вкладка, забытая на ночь, — это не «читал»,
  // а мусор, который сдвинул бы среднее по странице в бессмыслицу.
  ms: z.number().int().min(0).max(6 * 60 * 60 * 1000),
});

const dwellLimiter = createRateLimiter({ windowMs: 10_000, max: 30 });

export async function POST(req: NextRequest) {
  if (!dwellLimiter.check(getClientIp(req.headers))) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const parsed = DwellSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });

  // dwell_ms IS NULL — дописываем ровно один раз: повторный beacon (браузеры
  // умеют слать pagehide и visibilitychange подряд) не должен затирать первое,
  // честное значение вторым, снятым уже после ухода.
  const wrote = await pool.query(
    `UPDATE page_views SET dwell_ms = $2 WHERE id = $1 AND dwell_ms IS NULL`,
    [String(parsed.data.id), parsed.data.ms],
  ).then(() => true).catch((e: { code?: string }) => {
    console.error('[analytics/dwell] время не записано:', e?.code ?? 'нет SQLSTATE');
    return false;
  });

  // Время на странице — взаимодействие, только если оно не короче
  // ENGAGED_DWELL_MS: короткое трекер шлёт сам при любом уходе, и бот,
  // обходящий страницы, оставляет его на каждой строке. Судит записанное
  // значение (touched.dwell_ms), а не присланное: оно пишется один раз, и
  // повтор с длинным временем поверх короткого метку не снимает.
  // Снимаем только метку порога (anomaly_bot) и только своего визита:
  // строки того же sessionId (без него — сама строка) за те же камчатские
  // сутки. Не бота по адресу браузера, не свой заход и не чужой визит того же
  // адреса: id строки последовательный, и доклад по чужому id не должен
  // возвращать в люди весь адрес. Колонки ещё нет — 42703, время уже записано.
  if (wrote) {
    await pool.query(
      `UPDATE page_views AS p
          SET is_bot = $3, anomaly_bot = $3
         FROM page_views AS touched
        WHERE touched.id = $1
          AND touched.ip_hash IS NOT NULL
          AND touched.dwell_ms >= $2
          AND p.ip_hash = touched.ip_hash
          AND (p.id = touched.id OR p.session_id = touched.session_id)
          AND p.anomaly_bot
          AND NOT p.is_self
          AND p.created_at >= (date_trunc('day', touched.created_at AT TIME ZONE 'Asia/Kamchatka') AT TIME ZONE 'Asia/Kamchatka')
          AND p.created_at < (date_trunc('day', touched.created_at AT TIME ZONE 'Asia/Kamchatka') AT TIME ZONE 'Asia/Kamchatka') + INTERVAL '1 day'`,
      [String(parsed.data.id), ENGAGED_DWELL_MS, false],
    ).catch((e: { code?: string }) => {
      if (e?.code === '42703') return;
      console.error('[analytics/dwell] метка порога не снята:', e?.code ?? 'нет SQLSTATE');
    });
  }

  return NextResponse.json({ ok: true });
}
