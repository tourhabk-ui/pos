/**
 * POST /api/cron/backfill-place-images — генерит фото для точек без изображений.
 *
 * Одна пачка за вызов (генерация через Qwen-Image медленная, ~30–40с/шт —
 * держимся в maxDuration). Воркфлоу cron-place-images.yml зовёт эндпоинт в цикле
 * до remaining=0. Токен бота/ключи живут только на проде — авторизация по
 * CRON_SECRET (как у остальных cron-эндпоинтов).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import {
  generateAndStoreRouteImage,
  getRoutesWithoutImages,
} from '@/lib/services/ingest/ai-image-generator';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Консервативно: Qwen-Image ~30–40с/шт, укладываемся в 300с maxDuration.
const DEFAULT_BATCH = 6;
const MAX_BATCH = 10;

const Schema = z.object({ batch: z.number().int().positive().max(MAX_BATCH).optional() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные данные' }, { status: 400 });
  }
  const batch = Math.min(parsed.data.batch ?? DEFAULT_BATCH, MAX_BATCH);

  let missing;
  try {
    missing = await getRoutesWithoutImages();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка выборки';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  const todo = missing.slice(0, batch);
  let generated = 0;
  let failed = 0;
  const bySource: Record<string, number> = {};

  for (const route of todo) {
    try {
      const res = await generateAndStoreRouteImage(
        route.id, route.title, route.location_type, route.description ?? '',
      );
      generated++;
      // model возвращается через GenerateResult только косвенно — считаем факты
      bySource[res.cached ? 'cached' : 'generated'] =
        (bySource[res.cached ? 'cached' : 'generated'] ?? 0) + 1;
    } catch {
      failed++;
    }
  }

  return NextResponse.json({
    success: true,
    generated,
    failed,
    processed: todo.length,
    remaining: Math.max(0, missing.length - generated),
  });
}
