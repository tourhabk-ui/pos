/**
 * GET /api/cron/route-data-audit?secret=<CRON_SECRET>[&limit=N]
 *
 * Перепись качества данных маршрутов: у скольких вообще есть линия, у
 * скольких она набросок вместо снятого трека, и у скольких точки лежат
 * дальше двух километров от собственной линии.
 *
 * Зачем: владелец просит перенести маршруты в единую базу. Переносить 421
 * маршрут вслепую нельзя — это данные, от которых зависит безопасность, и
 * «перебрать всё» без понимания, что именно сломано, есть действие без
 * измерения. Сначала цифры, потом решение по каждому классу.
 *
 * READ-ONLY, под CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runGeometryAudit } from '@/lib/routes/geometry-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Версия ФОРМЫ ответа. Растёт, когда перепись начинает считать что-то новое.
 *
 * Прогон 18.08 01:14 вернул успех и старые цифры: мерж прошёл в 01:05, сборка
 * Timeweb идёт минут десять, и перепись спросила прежний контейнер. Внешне это
 * выглядело как ответ — блоки, счётчики, зелёный прогон, — а на деле мы
 * смотрели в прибор, которого ещё не существовало.
 *
 * Это тот самый класс, который мы весь вечер и вычищали: молчание, читаемое
 * как ответ. Номер версии позволяет прогону дождаться СВОЕГО кода, а не
 * гадать по наличию блоков в выводе.
 *
 * Отдаётся и в теле 401 — чтобы ждать можно было без секрета и без запуска
 * тяжёлой переписи на каждую попытку.
 *
 *   1 — счётчики геометрии, черта, туры
 *   2 — причины отказа поимённо, улики записи, отделение мусора
 *   3 — ровность шага в уликах, записи-близнецы по именам
 *   4 — черта спрашивает улику: доказанная запись возвращает право вести
 */
export const AUDIT_SHAPE_VERSION = 4;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', v: AUDIT_SHAPE_VERSION }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('limit');
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  try {
    const audit = await runGeometryAudit(limit);
    return NextResponse.json({ success: true, v: AUDIT_SHAPE_VERSION, ...audit });
  } catch (err) {
    // Пустой аудит читался бы как «маршрутов нет» — то есть как «всё хорошо».
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Аудит не выполнен' },
      { status: 500 },
    );
  }
}
