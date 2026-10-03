/**
 * /api/cron/photo-audit — аудит ПОКАЗЫВАЕМЫХ снимков мест (миграция 1146).
 *
 * GET  ?secret   — отчёт, только чтение: дубли одного кадра у разных мест по
 *                  отпечатку, снимки с вердиктом зрения «водяной знак» или
 *                  «не тот род», и сколько снимков ещё без отпечатка/вердикта
 *                  («не проверено» — отдельное число, не ноль находок).
 * POST {task: 'phash'|'vision', reason, dry_run=true, limit≤10}
 *               — партия: посчитать отпечатки или спросить зрение у снимков,
 *                  у которых этого ещё нет. Пишет ТОЛЬКО свои колонки
 *                  (phash*, vision*); байты, род, автора и показ не трогает.
 *
 * Зовёт актуатор images-repack.yml задачами phash/vision партиями по 10 до
 * исчерпания. Правило и разбор ответа модели — lib/images/photo-audit.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { shownPhotoSql } from '@/lib/images/origin';
import { callVisionDetailed } from '@/lib/ai/providers';
import { placeTypeLabel } from '@/lib/places/type-label';
import {
  dHash, duplicatePairs, visionCopy, visionAuditPrompt, parseVisionVerdict, needsHumanEye,
  DUPLICATE_MAX_DISTANCE, type VisionVerdict,
} from '@/lib/images/photo-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

const BodySchema = z.object({
  task:    z.enum(['phash', 'vision']),
  reason:  z.string().min(10, 'Причина обязательна: зачем считаем снимки'),
  limit:   z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run: z.boolean().default(true),
});

function authorized(req: NextRequest): boolean {
  return timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '');
}

/** Живые места с показываемым снимком — одно условие на весь роут. */
const SHOWN_PLACE_FROM = `
  FROM ai_route_images i
  JOIN places p ON p.ark_id = i.route_id
 WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
   AND ${shownPhotoSql('i.model')}`;

interface CandidateRow {
  id: string; ark_id: string; place: string; location_type: string | null;
  image_data: Buffer | null; s3_url: string | null; mime_type: string | null;
}

/** Байты снимка: из базы, иначе из хранилища. null — с причиной. */
async function loadBytes(r: CandidateRow): Promise<{ buf: Buffer | null; reason: string | null }> {
  if (r.image_data) return { buf: r.image_data, reason: null };
  if (!r.s3_url) return { buf: null, reason: 'ни байтов, ни ссылки' };
  try {
    const res = await fetch(r.s3_url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { buf: null, reason: `хранилище ответило ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? { buf, reason: null } : { buf: null, reason: 'пустой объект' };
  } catch (err) {
    return { buf: null, reason: err instanceof Error ? err.message.slice(0, 200) : 'сеть' };
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { rows: fp } = await pool.query<{ ark_id: string; place: string; phash: string }>(
      `SELECT p.ark_id::text AS ark_id, p.name AS place, i.phash ${SHOWN_PLACE_FROM} AND i.phash IS NOT NULL`,
    );
    const pairs = duplicatePairs(fp.map(r => ({ arkId: r.ark_id, place: r.place, phash: r.phash })));
    const dupArk = new Set(pairs.flatMap(x => [x.a.arkId, x.b.arkId]));

    const { rows: vis } = await pool.query<{ ark_id: string; place: string; model: string | null; author: string | null; v: VisionVerdict; vision_at: string }>(
      `SELECT p.ark_id::text AS ark_id, p.name AS place, i.model, i.author, i.vision_verdict AS v,
              to_char(i.vision_at, 'YYYY-MM-DD') AS vision_at
         ${SHOWN_PLACE_FROM} AND i.vision_verdict IS NOT NULL
        ORDER BY p.name`,
    );
    const flagged = vis.filter(r => needsHumanEye(r.v, dupArk.has(r.ark_id)));

    const { rows: cnt } = await pool.query<{ shown: string; with_phash: string; with_vision: string }>(
      `SELECT count(*)::text AS shown,
              count(i.phash)::text AS with_phash,
              count(i.vision_verdict)::text AS with_vision
         ${SHOWN_PLACE_FROM}`,
    );
    const shown = Number(cnt[0]?.shown ?? 0);
    return NextResponse.json({
      ok: true, probe: 'photo_audit_v1',
      shown,
      // «Не проверено» — отдельные числа: ноль находок при нуле отпечатков не успех (§4.0).
      without_phash: shown - Number(cnt[0]?.with_phash ?? 0),
      without_vision: shown - Number(cnt[0]?.with_vision ?? 0),
      duplicate_max_distance: DUPLICATE_MAX_DISTANCE,
      duplicates: pairs.map(x => ({
        distance: x.distance,
        places: [x.a.place, x.b.place],
        image_urls: [`/api/images/route/${x.a.arkId}`, `/api/images/route/${x.b.arkId}`],
      })),
      flagged_by_vision: flagged.map(r => ({
        place: r.place, model: r.model, author: r.author, image_url: `/api/images/route/${r.ark_id}`,
        watermark: r.v.watermark, matches_type: r.v.matchesType, depicts: r.v.depicts,
        duplicate: dupArk.has(r.ark_id), checked: r.vision_at, by: r.v.model,
      })),
      vision_unknown: vis.filter(r => r.v.watermark === 'unknown' && r.v.matchesType === 'unknown').length,
      note: 'Дубль — по отпечатку восприятия (dHash), детерминированно. Вердикт зрения — подсказка для разбора глазами, ' +
        'не приговор: снимок снимается с показа только рукой человека. Снимки без отпечатка или вердикта не проверены, а не чисты.',
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[photo-audit] отчёт не собрался:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ ok: false, error: 'Отчёт не собрался', sqlstate: e?.code ?? null }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }
  const { task, reason, limit, dry_run } = parsed.data;
  const missing = task === 'phash' ? 'i.phash IS NULL' : 'i.vision_verdict IS NULL';

  try {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT i.id::text, p.ark_id::text AS ark_id, p.name AS place, p.location_type,
              i.image_data, i.s3_url, i.mime_type
         ${SHOWN_PLACE_FROM} AND ${missing}
        ORDER BY p.name
        LIMIT $1`,
      [limit],
    );
    const { rows: left } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n ${SHOWN_PLACE_FROM} AND ${missing}`);
    const pendingBefore = Number(left[0]?.n ?? 0);

    if (dry_run) {
      return NextResponse.json({
        ok: true, probe: 'photo_audit_v1', task, dry_run: true, reason,
        pending_before: pendingBefore,
        would_process: rows.map(r => ({ place: r.place, storage: r.image_data ? 'байты в базе' : r.s3_url ? 's3' : 'ни байтов, ни ссылки' })),
      });
    }

    const done: Array<Record<string, unknown>> = [];
    const failed: Array<{ place: string; reason: string }> = [];
    for (const r of rows) {
      const { buf, reason: why } = await loadBytes(r);
      if (!buf) { failed.push({ place: r.place, reason: why ?? 'байты не получены' }); continue; }
      try {
        if (task === 'phash') {
          const h = await dHash(buf);
          await pool.query(`UPDATE ai_route_images SET phash = $2, phash_at = NOW() WHERE id = $1 AND phash IS NULL`, [r.id, h]);
          done.push({ place: r.place, phash: h });
        } else {
          const copy = await visionCopy(buf);
          const typeLabel = placeTypeLabel(r.location_type) ?? 'место';
          const result = await callVisionDetailed(copy.base64, copy.mimeType, visionAuditPrompt(r.place, typeLabel));
          if (!result.text) {
            // Ни одна ступень не ответила — это «не смог», вердикт не пишется,
            // снимок остаётся в очереди; причина — в ответе партии.
            failed.push({ place: r.place, reason: `зрение не ответило: ${result.legs.map(l => `${l.provider}:${l.outcome}`).join(', ')}` });
            continue;
          }
          const verdict = parseVisionVerdict(result);
          await pool.query(
            `UPDATE ai_route_images SET vision_verdict = $2::jsonb, vision_at = NOW() WHERE id = $1 AND vision_verdict IS NULL`,
            [r.id, JSON.stringify(verdict)],
          );
          done.push({ place: r.place, watermark: verdict.watermark, matches_type: verdict.matchesType, depicts: verdict.depicts, by: verdict.model });
        }
      } catch (err) {
        failed.push({ place: r.place, reason: err instanceof Error ? err.message.slice(0, 200) : 'ошибка обработки' });
      }
    }
    return NextResponse.json({
      ok: true, probe: 'photo_audit_v1', task, dry_run: false, reason,
      pending_before: pendingBefore,
      audited_count: done.length,
      failed_count: failed.length,
      done, failed,
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[photo-audit] партия не выполнилась:', task, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ ok: false, error: 'Партия не выполнилась', sqlstate: e?.code ?? null }, { status: 500 });
  }
}
