/**
 * POST /api/cron/images-to-s3 — перенести снимки мест из базы в S3.
 *
 * ПОВОД — замер 08.09 (`GET /api/cron/db-size-census`, prod-check run 42):
 * база 839,9 МБ, из них 439,6 МБ — одна таблица `ai_route_images`, 657 строк
 * по ~670 КБ. Снимки лежат бинарём в PostgreSQL, при том что рядом S3 на
 * 100 ГБ — оплаченный, подключённый и уже используемый. Комментарий миграции
 * 107, заведшей таблицу: «TEMPORARY until real photos are uploaded».
 *
 * ПОРЯДОК ДЕЙСТВИЙ НАД КАЖДЫМ СНИМКОМ — и он не переставляется:
 *
 *   1. залить объект в S3;
 *   2. ПРОЧИТАТЬ его обратно и сверить размер с исходным;
 *   3. только теперь записать s3_key/s3_url и обнулить image_data.
 *
 * Второй шаг не формальность. Без него «переехало» и «потеряно» выглядят
 * одинаково: заливка вернула успех, объект недоступен, байты стёрты — и
 * узнаем мы об этом с чужого экрана, когда снимок уже не восстановить.
 * Не сошёлся размер или объект не читается — строка остаётся нетронутой и
 * попадает в отчёт отдельным списком (§4.0: «не смог» это не «сделал»).
 *
 * Правила партии — те же, что у остальных пишущих разборов:
 *   - `dry_run` по умолчанию: сначала план, потом запись;
 *   - боевая партия не больше 10 (правило владельца «лучше по 10»);
 *   - `reason` обязателен и без умолчания: через месяц должно быть видно,
 *     зачем трогали данные;
 *   - идемпотентность по построению: берутся только строки без `s3_key`,
 *     повтор ничего не портит и ничего не дублирует.
 *
 * ЧЕГО РОУТ НЕ ДЕЛАЕТ. Не трогает пишущие пути (`admin/places/[id]/photo`,
 * `wiki-candidates`) — они по-прежнему кладут байты в базу, и это осознанно
 * оставлено на отдельный заход: перевозчик подберёт новые строки следующим
 * прогоном, а смешивать переезд с изменением приёма снимков значило бы
 * менять два пути разом.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { uploadToS3 } from '@/lib/storage/s3';

export const dynamic     = 'force-dynamic';
export const maxDuration = 120;

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

const BodySchema = z.object({
  reason:  z.string().min(10, 'Причина обязательна: зачем трогаем данные'),
  limit:   z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run: z.boolean().default(true),
});

interface Row {
  id: string;
  route_id: string;
  mime_type: string | null;
  image_data: Buffer | null;
  size_bytes: string;
}

/** Расширение по MIME — ключ объекта должен читаться человеком. */
function extFor(mime: string): string {
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('avif')) return 'avif';
  return 'jpg';
}

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Неверные параметры' },
      { status: 400 },
    );
  }
  const { reason, limit, dry_run } = parsed.data;

  try {
    const { rows } = await pool.query<Row>(
      `SELECT id::text, route_id::text, mime_type, image_data,
              OCTET_LENGTH(image_data)::text AS size_bytes
         FROM ai_route_images
        WHERE s3_key IS NULL AND image_data IS NOT NULL
        ORDER BY OCTET_LENGTH(image_data) DESC
        LIMIT $1`,
      [limit],
    );

    // Осталось всего — чтобы по ответу было видно, сколько ещё прогонов.
    const { rows: leftRows } = await pool.query<{ pending: string; pending_mb: string }>(
      `SELECT COUNT(*)::text AS pending,
              ROUND(COALESCE(SUM(OCTET_LENGTH(image_data)), 0) / 1048576.0, 1)::text AS pending_mb
         FROM ai_route_images
        WHERE s3_key IS NULL AND image_data IS NOT NULL`,
    );

    const plan = rows.map((r) => ({
      id: r.id,
      route_id: r.route_id,
      size_kb: Math.round(Number(r.size_bytes) / 1024),
      key: `places/${r.route_id}/${r.id}.${extFor(r.mime_type ?? 'image/jpeg')}`,
    }));

    if (dry_run) {
      return NextResponse.json({
        ok: true,
        probe: 'images_to_s3_v1',
        dry_run: true,
        reason,
        pending: Number(leftRows[0]?.pending ?? '0'),
        pending_mb: Number(leftRows[0]?.pending_mb ?? '0'),
        would_move: plan,
      });
    }

    const moved: Array<{ id: string; key: string; size_kb: number }> = [];
    // «Не смог» — отдельным списком, а не молчанием: строка осталась в базе,
    // и по отчёту должно быть видно, какая именно и почему.
    const failed: Array<{ id: string; reason: string }> = [];

    for (const r of rows) {
      const item = plan.find(p => p.id === r.id)!;
      if (!r.image_data) { failed.push({ id: r.id, reason: 'байтов нет' }); continue; }

      try {
        const uploaded = await uploadToS3(item.key, r.image_data, r.mime_type ?? 'image/jpeg');

        // ПРОВЕРКА ДО УДАЛЕНИЯ. Заливка вернула успех — этого мало: объект
        // должен читаться и совпадать по размеру. Иначе байты будут стёрты
        // ради ссылки, которая никуда не ведёт.
        const check = await fetch(uploaded.url, { method: 'GET', cache: 'no-store' });
        if (!check.ok) {
          failed.push({ id: r.id, reason: `объект не читается: HTTP ${check.status}` });
          continue;
        }
        const readBack = Buffer.from(await check.arrayBuffer());
        if (readBack.length !== r.image_data.length) {
          failed.push({
            id: r.id,
            reason: `размер не сошёлся: залито ${r.image_data.length}, прочитано ${readBack.length}`,
          });
          continue;
        }

        await pool.query(
          `UPDATE ai_route_images
              SET s3_key = $1, s3_url = $2, image_data = NULL
            WHERE id = $3::uuid AND s3_key IS NULL`,
          [uploaded.key, uploaded.url, r.id],
        );
        moved.push({ id: r.id, key: uploaded.key, size_kb: item.size_kb });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[images-to-s3] снимок ${r.id} не переехал:`, msg);
        failed.push({ id: r.id, reason: msg.slice(0, 200) });
      }
    }

    return NextResponse.json({
      ok: true,
      probe: 'images_to_s3_v1',
      dry_run: false,
      reason,
      moved_count: moved.length,
      failed_count: failed.length,
      freed_kb: moved.reduce((s, m) => s + m.size_kb, 0),
      moved,
      failed,
      pending_before: Number(leftRows[0]?.pending ?? '0'),
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-to-s3] разбор не выполнен, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_to_s3_v1', error: 'разбор не выполнен', sqlstate: code },
      { status: 503 },
    );
  }
}
