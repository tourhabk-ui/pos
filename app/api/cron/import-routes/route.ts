/**
 * GET /api/cron/import-routes
 * Импорт знаний о маршрутах и местах Камчатки из открытых источников.
 *
 * ?source=visitkamchatka  — паспорта маршрутов (visitkamchatka.ru)
 * ?source=kamchatkaland   — тематические статьи (kamchatkaland.ru) → раздел
 *                           статей `articles`, НЕ справочник маршрутов (08.09)
 * ?source=all             — оба источника (по умолчанию)
 *
 * `?source=places` больше нет: обогатитель описаний мест скрейпил чужие сайты
 * (extraguide.ru, tur-ray.ru, spkam.com) и удалён 08.09 — решение владельца,
 * то же, что по idilesom. Сторож: tests/unit/places-enricher-purged.test.ts
 * ?batch=N                — размер батча (default 20)
 *
 * Auth: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runVisitKamchatkaImporter } from '@/lib/agents/visitkamchatka-importer';
import { runKamchatkalandImporter } from '@/lib/agents/kamchatkaland-importer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Общий хелпер вместо разбора заголовка руками (сторож
  // api-guard-before-action, 01.09).
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const source = request.nextUrl.searchParams.get('source') ?? 'all';
  const batchParam = request.nextUrl.searchParams.get('batch');
  const batch = batchParam ? Math.min(50, parseInt(batchParam, 10) || 20) : 20;

  try {
    const results: Record<string, unknown> = {};

    if (source === 'visitkamchatka' || source === 'all') {
      results.visitkamchatka = await runVisitKamchatkaImporter(batch);
    }
    if (source === 'kamchatkaland' || source === 'all') {
      results.kamchatkaland = await runKamchatkalandImporter(Math.ceil(batch / 2));
    }

    return NextResponse.json({ success: true, ...results });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
