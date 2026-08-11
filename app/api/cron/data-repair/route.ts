/**
 * GET /api/cron/data-repair?secret=<CRON_SECRET>[&apply=1][&only=<шаг>]
 *
 * Ремонт географических данных по итогам инвентаризации: фейковые
 * координаты-заглушки, дубли мест, привязка треков всех источников,
 * нормализация source_name, места-статьи. Без apply=1 — dry-run
 * (диагностика, ни одного UPDATE). Дергается workflow'ом data-repair.yml.
 *
 * `only=<шаг>` сужает ПРИМЕНЕНИЕ до одного шага; остальные в этом прогоне
 * остаются диагностикой. Понадобилось 11.08: чтобы убрать 26 заметок сайта
 * из справочника маршрутов, пришлось бы запустить apply целиком — а он в том
 * же прогоне спрятал бы ещё шесть мест и отвязал две путевые точки, о чём
 * никто не просил. Согласие на одно действие не есть согласие на все.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { runDataRepair } from '@/lib/services/data-repair';
import { logAgentRun } from '@/lib/agents/run-logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apply = request.nextUrl.searchParams.get('apply') === '1';
  const only = request.nextUrl.searchParams.get('only') ?? undefined;
  const startedAt = new Date();
  try {
    const result = await runDataRepair(!apply, only);

    void logAgentRun({
      agent_id: 'data-repair',
      status: result.errors === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'data-repair',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка ремонта данных' },
      { status: 500 },
    );
  }
}
