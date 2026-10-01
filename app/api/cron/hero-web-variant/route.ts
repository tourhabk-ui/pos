/**
 * /api/cron/hero-web-variant — веб-копия героев, перенесённых из снимков
 * туристов ОРИГИНАЛОМ загрузки.
 *
 * ПОВОД. Аудит vedarai.ru 01.10: главная весила 8,7 МБ на телефоне, 6,1 МБ из
 * них — один герой карточки места, снимок туриста 3000x4000. Перенос в герои
 * (lib/places/user-photo-hero) ставил s3_url ссылкой на оригинал загрузки, а
 * загрузка хранится как есть. images-recompress его не видит: он пережимает
 * байты в базе, а этот снимок лежит объектом в хранилище — путь «скачать из
 * хранилища, пережать, залить обратно» и был тем, которого не хватало
 * (CLAUDE.md, «Снимок места живёт в хранилище»).
 *
 * КАНДИДАТ. Герой, у которого s3_url совпадает с source_url: так пишет только
 * перенос из снимка туриста, когда копии нет. У переехавших в хранилище
 * снимков source_url — внешний источник, у копий — оригинал загрузки, и
 * совпадения нет.
 *
 * ПОРЯДОК над каждым снимком не переставляется: скачать оригинал, сделать
 * копию, ПРОВЕРИТЬ её, залить, ПРОЧИТАТЬ обратно и сверить размер, и только
 * потом переписать s3_url — и только если строка не менялась. Оригинал не
 * удаляется и остаётся в source_url: копия производная.
 *
 * Правила партии те же, что у остальных пишущих разборов: dry_run по
 * умолчанию, партия не больше 10, reason обязателен. Bearer CRON_SECRET.
 * Запуск — задачей `hero` актуатора images-repack.yml.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { heroVariantFor, heroVariantKey } from '@/lib/places/hero-variant';

export const dynamic     = 'force-dynamic';
export const maxDuration = 300;

const PROBE = 'hero_web_variant_v1';

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

const BodySchema = z.object({
  reason:  z.string().min(10, 'Причина обязательна: зачем трогаем снимки'),
  limit:   z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run: z.boolean().default(true),
});

interface Row {
  id: string;
  route_id: string;
  s3_url: string;
  place_name: string | null;
}

const CANDIDATE_WHERE = `i.image_data IS NULL
        AND i.s3_url IS NOT NULL
        AND i.s3_url = i.source_url`;

async function candidates(limit: number) {
  const { rows } = await pool.query<Row>(
    `SELECT i.id::text, i.route_id::text, i.s3_url, p.name AS place_name
       FROM ai_route_images i
       LEFT JOIN places p ON p.ark_id = i.route_id
      WHERE ${CANDIDATE_WHERE}
      ORDER BY i.created_at DESC
      LIMIT $1`,
    [limit],
  );
  const { rows: left } = await pool.query<{ pending: string }>(
    `SELECT COUNT(*)::text AS pending FROM ai_route_images i WHERE ${CANDIDATE_WHERE}`,
  );
  return {
    rows,
    pending: Number(left[0]?.pending ?? '0'),
    plan: rows.map((r) => ({ id: r.id, subject: r.place_name, source: r.s3_url })),
  };
}

function authorized(req: NextRequest): boolean {
  return timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '');
}

function sqlFailure(where: string, err: unknown) {
  const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
  console.error(`[hero-web-variant] ${where}, SQLSTATE ${code}:`, err);
  return NextResponse.json({ ok: false, probe: PROBE, error: where, sqlstate: code }, { status: 503 });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { plan, pending } = await candidates(MAX_BATCH);
    return NextResponse.json({
      ok: true,
      probe: PROBE,
      dry_run: true,
      method: 'GET',
      pending,
      would_resize: plan,
      meaningful: plan.length > 0,
      note: 'только план: GET ничего не пишет. Копии — POST с причиной и явным dry_run: false',
    });
  } catch (err) {
    return sqlFailure('план не собран', err);
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  let picked: Awaited<ReturnType<typeof candidates>>;
  try {
    picked = await candidates(limit);
  } catch (err) {
    return sqlFailure('кандидаты не прочитаны', err);
  }

  if (dry_run) {
    return NextResponse.json({
      ok: true, probe: PROBE, dry_run: true, reason,
      pending: picked.pending, would_resize: picked.plan,
    });
  }

  const done: Array<{ id: string; subject: string | null; was_kb: number; now_kb: number; size: string }> = [];
  // «Копия не нужна» — оригинал и так лёгкий: это не отказ, но и не работа.
  const skipped: Array<{ id: string; reason: string }> = [];
  // «Не смог» отдельным списком: снимок остался тяжёлым, и по отчёту должно
  // быть видно какой и почему — иначе отказ неотличим от пустой партии.
  const failed: Array<{ id: string; reason: string }> = [];

  for (const r of picked.rows) {
    const variant = await heroVariantFor(r.s3_url, heroVariantKey(r.route_id, r.id));
    if (variant.status === 'not_needed') { skipped.push({ id: r.id, reason: variant.reason }); continue; }
    if (variant.status === 'failed') {
      console.error(`[hero-web-variant] снимок ${r.id} не уменьшен:`, variant.reason);
      failed.push({ id: r.id, reason: variant.reason });
      continue;
    }
    try {
      // Условие по прежней ссылке — оптимистическая блокировка: герой мог
      // смениться через админку между выборкой и записью.
      const res = await pool.query(
        `UPDATE ai_route_images
            SET s3_url = $1, s3_key = $2, width = $3, height = $4, mime_type = 'image/jpeg'
          WHERE id = $5::uuid AND s3_url = $6 AND image_data IS NULL`,
        [variant.url, variant.key, variant.width, variant.height, r.id, r.s3_url],
      );
      if ((res.rowCount ?? 0) === 0) {
        failed.push({ id: r.id, reason: 'герой изменился между планом и записью — не тронут' });
        continue;
      }
      done.push({
        id: r.id,
        subject: r.place_name,
        was_kb: Math.round(variant.wasBytes / 1024),
        now_kb: Math.round(variant.nowBytes / 1024),
        size: `${variant.width}x${variant.height}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[hero-web-variant] снимок ${r.id} не записан:`, msg);
      failed.push({ id: r.id, reason: msg.slice(0, 200) });
    }
  }

  return NextResponse.json({
    ok: true,
    probe: PROBE,
    dry_run: false,
    reason,
    pending_before: picked.pending,
    recompressed_count: done.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    resized: done,
    skipped,
    failed,
  });
}
