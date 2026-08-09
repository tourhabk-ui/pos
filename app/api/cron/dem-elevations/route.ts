/**
 * GET /api/cron/dem-elevations
 *
 * Дозаполнение высот треков из модели рельефа. Запускается с прод-сервера
 * партиями (workflow `import-dem-elevations.yml`) — как и импорт idilesom,
 * потому что внешние источники ходят к нам через IP Timeweb, а не из
 * песочницы разработки.
 *
 *   ?mode=probe  — только спросить у источника три известные точки и показать,
 *                  что он ответил. Ничего не пишет. Достижимость — половина
 *                  ответа: модель может отвечать и врать, поэтому проверяем
 *                  числами, а не кодом 200.
 *   ?limit=N     — сколько маршрутов взять за прогон (по умолчанию 5).
 *
 * Логика и правила честности — в `lib/services/relief/dem-backfill.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';
import { backfillDemElevations, probeDem } from '@/lib/services/relief/dem-backfill';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (request.nextUrl.searchParams.get('mode') === 'probe') {
    try {
      return NextResponse.json({ success: true, mode: 'probe', ...(await probeDem()) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ success: false, error: msg.slice(0, 300) }, { status: 502 });
    }
  }

  const started = new Date();
  // По три маршрута за раз: на длинных треках (полторы тысячи отсчётов)
  // пятёрка не укладывалась в бюджет и упиралась в шлюз.
  const raw = parseInt(request.nextUrl.searchParams.get('limit') ?? '3', 10);
  const limit = Number.isFinite(raw) ? raw : 3;

  try {
    const result = await backfillDemElevations({ limit });
    void logAgentRun({
      agent_id: 'dem-elevations',
      status: 'success',
      started_at: started,
      duration_ms: result.duration_ms,
      metadata: { checked: result.checked, written: result.written, skipped: result.skipped_no_data },
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logAgentRun({
      agent_id: 'dem-elevations',
      status: 'failed',
      started_at: started,
      duration_ms: Date.now() - started.getTime(),
      metadata: { error: msg.slice(0, 300) },
    });
    return NextResponse.json({ success: false, error: msg.slice(0, 300) }, { status: 500 });
  }
}
