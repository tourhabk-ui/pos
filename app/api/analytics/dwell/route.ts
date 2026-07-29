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
  await pool.query(
    `UPDATE page_views SET dwell_ms = $2 WHERE id = $1 AND dwell_ms IS NULL`,
    [String(parsed.data.id), parsed.data.ms],
  ).catch(() => { /* некритично: счётчик не должен ломать страницу */ });

  return NextResponse.json({ ok: true });
}
