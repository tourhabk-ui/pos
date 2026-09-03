/**
 * POST /api/cron/route-endpoints — извлечь точки начала/конца маршрута из
 * OCR-паспорта и записать в route_waypoints (Ф5-хвост, план в
 * .claude/ROUTES_ORDER_PLAN.md).
 *
 * Логика в lib/import/route-endpoints-runner.ts. Дисциплина та же, что у
 * tour-pickup / place-coords: source и why обязательны без умолчаний, сухой
 * прогон по умолчанию, партия не больше десяти.
 *
 * Пишет ТОЛЬКО точки (places + route_waypoints), не geometry: прямая линия
 * между началом и концом выглядела бы как путь, по которому идут, а это
 * не так (CLAUDE.md §12).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runRouteEndpoints } from '@/lib/import/route-endpoints-runner';
import { computeRouteEndpointsCensus, CENSUS_BATCH } from '@/lib/import/route-endpoints-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET — перепись (#1493, 02.09): у каких маршрутов есть OCR-паспорт и меньше
 * двух путевых точек, и у кого из них в тексте паспорта есть координата.
 * Только чтение, модель не зовётся; отдаёт первую партию из десяти —
 * материал для POST ниже. Логика — lib/import/route-endpoints-census.ts.
 */
export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const census = await computeRouteEndpointsCensus();
  return NextResponse.json({
    ok: census.rows !== null,
    probe: 'route_endpoints_v1',
    version: ROUTE_ENDPOINTS_VERSION,
    census_batch: CENSUS_BATCH,
    ...census,
  }, { status: census.rows === null ? 500 : 200 });
}

export const LIVE_BATCH_MAX = 10;

/**
 * Версия ответа, не имя роута: `probe` ниже — статичная строка, одинаковая
 * в любой сборке, и потому непригодна как маркер свежести для пробы
 * (проба 200, 24.08 — приняла закэшированный ответ за свежий, потому что
 * "route_endpoints_v1" был в обеих сборках байт в байт). Бампать при любом
 * поведенческом изменении раннера/парсера — тот же приём, что
 * ROUTE_CORE_VERSION / AUDIT_SHAPE_VERSION.
 */
export const ROUTE_ENDPOINTS_VERSION = 4;

const BodySchema = z.object({
  source: z.string().trim().min(3, 'Назовите источник').max(200),
  why: z.string().trim().min(3, 'Назовите причину').max(300),
  dry_run: z.boolean().default(true),
  route_ids: z.array(z.string().uuid()).min(1).max(LIVE_BATCH_MAX),
});

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message ?? 'Некорректные данные' : 'Некорректные данные';
    return NextResponse.json({ probe: 'route_endpoints_v1', version: ROUTE_ENDPOINTS_VERSION, error: msg }, { status: 400 });
  }

  try {
    const result = await runRouteEndpoints({
      routeIds: parsed.route_ids,
      source: parsed.source,
      why: parsed.why,
      dryRun: parsed.dry_run,
    });
    return NextResponse.json({ ok: true, probe: 'route_endpoints_v1', version: ROUTE_ENDPOINTS_VERSION, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, probe: 'route_endpoints_v1', version: ROUTE_ENDPOINTS_VERSION, error: err instanceof Error ? err.message : 'Не выполнено' },
      { status: 500 },
    );
  }
}
