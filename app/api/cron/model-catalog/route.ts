/**
 * POST /api/cron/model-catalog — приём каталога моделей с ценами от раннера.
 *
 * Прод каталог OpenRouter НЕ ВИДИТ: 403 и напрямую, и через релей (замер
 * 07.09). Поэтому наружу ходит раннер GitHub (`model-catalog.yml`), а сюда
 * приезжает готовый список. То же разделение труда, что у `editor-runner`:
 * список выбирает прод, наружу ходит раннер, результат возвращается на прод.
 *
 * Роут ничего не решает и ничего не переключает — он только записывает то,
 * что каталог сказал о ценах. Выбор модели остаётся за человеком.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { vendorOf } from '@/lib/ai/model-cost';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(300).nullable().optional(),
  // Цена приходит уже в $ за МИЛЛИОН токенов — раннер разбирает её общей
  // функцией parseCatalogPrice, чтобы «нет цены» и «цена ноль» не слились
  // по дороге. null здесь означает «каталог не назвал», а не «бесплатно».
  usd_per_mtok_in: z.number().nonnegative().nullable().optional(),
  usd_per_mtok_out: z.number().nonnegative().nullable().optional(),
  context_length: z.number().int().positive().max(100_000_000).nullable().optional(),
});

const BodySchema = z.object({
  source: z.string().min(1).max(50).default('openrouter'),
  fetched_at: z.string().datetime().optional(),
  models: z.array(ModelSchema).max(2000),
});

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !timingSafeCompare(secret ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Некорректное тело: ${e instanceof Error ? e.message.slice(0, 300) : 'разбор не удался'}` },
      { status: 400 },
    );
  }

  // Пустой каталог — ОТКАЗ, а не пустой каталог (§4.0). Каталог OpenRouter
  // содержит сотни моделей всегда; ноль означает, что прогон не смог его
  // прочитать. Записать ноль значило бы стереть цены и показать админке
  // «моделей нет» вместо «мы не смогли спросить».
  if (parsed.models.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Каталог пуст — это отказ прогона, а не пустой каталог. Ничего не записано.' },
      { status: 400 },
    );
  }

  const fetchedAt = parsed.fetched_at ? new Date(parsed.fetched_at) : new Date();
  let written = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const model of parsed.models) {
      await client.query(
        `INSERT INTO model_catalog
           (model_id, vendor, display_name, usd_per_mtok_in, usd_per_mtok_out,
            context_length, source, last_seen_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (model_id) DO UPDATE SET
           vendor           = EXCLUDED.vendor,
           display_name     = EXCLUDED.display_name,
           usd_per_mtok_in  = EXCLUDED.usd_per_mtok_in,
           usd_per_mtok_out = EXCLUDED.usd_per_mtok_out,
           context_length   = EXCLUDED.context_length,
           source           = EXCLUDED.source,
           last_seen_at     = EXCLUDED.last_seen_at,
           updated_at       = now()`,
        [
          model.id,
          vendorOf(model.id),
          model.name ?? null,
          model.usd_per_mtok_in ?? null,
          model.usd_per_mtok_out ?? null,
          model.context_length ?? null,
          parsed.source,
          fetchedAt,
        ],
      );
      written += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Отказ не глушится: без строки в логе «цены не обновились» выглядит
    // ровно как «цены не менялись».
    console.error('[model-catalog] партия не записана', {
      models: parsed.models.length,
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { success: false, error: 'Партия не записана — см. лог сервера' },
      { status: 500 },
    );
  } finally {
    client.release();
  }

  return NextResponse.json({
    success: true,
    written,
    source: parsed.source,
    fetched_at: fetchedAt.toISOString(),
  });
}
