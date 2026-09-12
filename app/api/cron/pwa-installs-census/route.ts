/**
 * GET /api/cron/pwa-installs-census — сколько устройств поставили и открыли PWA.
 *
 * Тот же счёт, что уже есть в `/api/admin/dashboard` (requireAdmin, JWT-кука),
 * но здесь — без входа в аккаунт, для разовой сверки числа (перепись, не
 * сервис для витрины). `pwa_installs.client_id` — первичный ключ, дедуп на
 * запись, поэтому `COUNT(*)` уже считает устройства, не события (миграция 798).
 *
 * Число — нижняя граница (не все браузеры шлют appinstalled/standalone-launch),
 * не «точное число скачиваний» — так же честно, как в самой миграции.
 *
 * Только чтение. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const totalResult = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM pwa_installs`,
    );
    const byPlatformResult = await pool.query<{ platform: string | null; n: string }>(
      `SELECT platform, COUNT(*)::text AS n
         FROM pwa_installs
        GROUP BY platform
        ORDER BY COUNT(*) DESC`,
    );
    const bySourceResult = await pool.query<{ install_source: string | null; n: string }>(
      `SELECT install_source, COUNT(*)::text AS n
         FROM pwa_installs
        GROUP BY install_source
        ORDER BY COUNT(*) DESC`,
    );

    return NextResponse.json({
      success: true,
      probe: 'pwa_installs_census_v1',
      total_devices: Number(totalResult.rows[0]?.total ?? '0'),
      by_platform: byPlatformResult.rows.map(r => ({
        platform: r.platform ?? 'не записано',
        count: Number(r.n),
      })),
      by_install_source: bySourceResult.rows.map(r => ({
        source: r.install_source ?? 'не записано',
        count: Number(r.n),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи установок PWA';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
