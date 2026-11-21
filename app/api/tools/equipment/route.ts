/**
 * POST /api/tools/equipment — чек-лист снаряжения по маршруту и дате.
 *
 * С 21.11 (слово владельца «го») список собирается из данных маршрута
 * правилом `buildGearChecklist` (lib/preparation/gear-checklist.ts), без модели:
 * прежде его писала языковая модель — до сорока секунд ожидания, «AI вернул
 * некорректный ответ» и предупреждения о безопасности, сочинённые без данных.
 * Данные маршрута — тот же загрузчик, что у карточки маршрута
 * (`loadRouteDetail`), поэтому список и карточка не расходятся.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { loadRouteDetail } from '@/lib/routes/route-detail';
import { buildGearChecklist, ESSENTIALS_SOURCE } from '@/lib/preparation/gear-checklist';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Модели больше нет, но загрузчик карточки — десяток запросов к базе.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const BodySchema = z.object({
  routeId: z.string().uuid('Маршрут не выбран'),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД'),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов — подождите минуту' }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный запрос' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const { routeId, dateFrom } = parsed.data;

  try {
    const detail = await loadRouteDetail(routeId, { explain: false, countView: false });
    if (detail.kind !== 'found') {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }
    const d = detail.data;
    const checklist = buildGearChecklist({
      id: d.id,
      title: d.title,
      equipment: d.equipment,
      hazards: d.hazards,
      mchsRequired: d.mchsRequired,
      parkName: d.parkName,
      season: d.season,
      bestMonths: d.bestMonths ?? [],
    }, dateFrom);
    if (!checklist) {
      return NextResponse.json({ success: false, error: 'Дата не распознана' }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: { ...checklist, dateFrom, essentialsSource: ESSENTIALS_SOURCE } });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tools/equipment] маршрут не прочитался:', `SQLSTATE=${e?.code ?? 'нет'}`, (e?.message ?? '').slice(0, 200));
    return NextResponse.json({ success: false, error: 'Не удалось прочитать маршрут — попробуйте ещё раз через минуту' }, { status: 503 });
  }
}
