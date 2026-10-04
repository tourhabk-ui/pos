/**
 * /api/cron/user-photo-moderate — агент модерации снимков туристов
 * (user_place_photos). Решение владельца 04.10: «модерирует пусть кто-то из
 * наших агентов по расписанию», агент сам одобряет и отклоняет, «после
 * первых пяти проверим».
 *
 * GET           — перепись: сколько ждёт, последние решения агента с причинами
 *                 (по ним и проверяются «первые пять»). Только чтение.
 * POST {reason, dry_run=true, limit≤5}
 *               — партия: берёт ждущие снимки, которых агент ещё не смотрел,
 *                 считает отпечаток, ищет повтор среди снимков того же места,
 *                 спрашивает зрение и решает (lib/images/user-photo-moderation).
 *                 Пишет статус ТОЛЬКО поверх 'pending': решение человека,
 *                 принятое между чтением и записью, агент не перезаписывает.
 *                 «Человеку» — статус не меняется, причина пишется.
 *
 * Зрение не ответило — это «не смог»: вердикт не пишется, снимок остаётся в
 * очереди агента на следующий прогон (§4.0). Админу — сводка в Telegram.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { callVisionDetailed } from '@/lib/ai/providers';
import { placeTypeLabel } from '@/lib/places/type-label';
import { dHash, hamming, visionCopy, DUPLICATE_MAX_DISTANCE } from '@/lib/images/photo-audit';
import { decideUserPhoto, parseUserPhotoVerdict, userPhotoPrompt } from '@/lib/images/user-photo-moderation';
import { escapeHtml } from '@/lib/text/escape-html';
import { logAgentRun } from '@/lib/agents/run-logger';
import { tgSend } from '@/lib/notifications/tg-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Пять за прогон: зрение медленное, и «первые пять» владелец смотрит сам. */
const MAX_BATCH = 5;

const BodySchema = z.object({
  reason:  z.string().min(10, 'Причина обязательна'),
  limit:   z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run: z.boolean().default(true),
});

function authorized(req: NextRequest): boolean {
  return timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '');
}

interface Candidate {
  id: string; place_id: string; place: string; location_type: string | null;
  ark_id: string | null; url: string;
}

async function loadBytes(url: string): Promise<{ buf: Buffer | null; reason: string | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { buf: null, reason: `хранилище ответило ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? { buf, reason: null } : { buf: null, reason: 'пустой объект' };
  } catch (err) {
    return { buf: null, reason: err instanceof Error ? err.message.slice(0, 200) : 'сеть' };
  }
}

/** Повтор: тот же кадр уже лежит у этого места — у туристов или в галерее платформы. */
async function findDuplicate(c: Candidate, phash: string): Promise<string | null> {
  const { rows } = await pool.query<{ src: string; phash: string }>(
    `SELECT 'снимок туриста' AS src, u.phash
       FROM user_place_photos u
      WHERE u.place_id = $1 AND u.id::text <> $2 AND u.phash IS NOT NULL AND u.status <> 'rejected'
     UNION ALL
     SELECT 'снимок платформы' AS src, i.phash
       FROM ai_route_images i
      WHERE $3::text IS NOT NULL AND i.route_id::text = $3::text AND i.phash IS NOT NULL`,
    [c.place_id, c.id, c.ark_id],
  );
  const hit = rows.find((r) => hamming(r.phash, phash) <= DUPLICATE_MAX_DISTANCE);
  return hit ? hit.src : null;
}

/** Сводка админу общим отправителем (lib/notifications/tg-send): отказ доставки назван, а не проглочен. */
async function notifyAdmin(lines: string[]): Promise<boolean | null> {
  if (lines.length === 0) return null;
  const out = await tgSend(
    'user-photo-moderate',
    ['<b>Модерация фото туристов</b>', '', ...lines, '', 'Очередь: /hub/admin/user-photos'].join('\n'),
  );
  return out.ok;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { rows: cnt } = await pool.query<{ pending: string; unseen: string }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'pending' AND agent_at IS NULL)::text AS unseen
         FROM user_place_photos`,
    );
    const { rows: recent } = await pool.query(
      `SELECT u.id::text, p.name AS place, u.status, u.agent_decision, u.agent_reason,
              u.vision_verdict, to_char(u.agent_at, 'YYYY-MM-DD HH24:MI') AS agent_at, u.url
         FROM user_place_photos u
         LEFT JOIN places p ON p.id::text = u.place_id
        WHERE u.agent_at IS NOT NULL
        ORDER BY u.agent_at DESC
        LIMIT 20`,
    );
    return NextResponse.json({
      ok: true, probe: 'user_photo_moderate_v1',
      pending: Number(cnt[0]?.pending ?? 0),
      unseen_by_agent: Number(cnt[0]?.unseen ?? 0),
      recent_decisions: recent,
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[user-photo-moderate] перепись не прочиталась:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ ok: false, error: 'Перепись не прочиталась', sqlstate: e?.code ?? null }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }
  const { reason, limit, dry_run } = parsed.data;
  const started_at = new Date();

  try {
    const { rows } = await pool.query<Candidate>(
      `SELECT u.id::text, u.place_id, p.name AS place, p.location_type, p.ark_id::text AS ark_id, u.url
         FROM user_place_photos u
         JOIN places p ON p.id::text = u.place_id
        WHERE u.status = 'pending' AND u.agent_at IS NULL
        ORDER BY u.created_at
        LIMIT $1`,
      [limit],
    );
    if (dry_run) {
      return NextResponse.json({ ok: true, dry_run: true, reason, would_process: rows.map((r) => ({ id: r.id, place: r.place })) });
    }

    const done: Array<Record<string, unknown>> = [];
    const failed: Array<{ id: string; place: string; reason: string }> = [];
    for (const c of rows) {
      const { buf, reason: why } = await loadBytes(c.url);
      if (!buf) { failed.push({ id: c.id, place: c.place, reason: why ?? 'байты не получены' }); continue; }
      try {
        const phash = await dHash(buf);
        await pool.query(`UPDATE user_place_photos SET phash = $2 WHERE id::text = $1 AND phash IS NULL`, [c.id, phash]);
        const duplicateOf = await findDuplicate(c, phash);

        const copy = await visionCopy(buf);
        const result = await callVisionDetailed(copy.base64, copy.mimeType, userPhotoPrompt(c.place, placeTypeLabel(c.location_type) ?? 'место'));
        if (!result.text && !duplicateOf) {
          failed.push({ id: c.id, place: c.place, reason: `зрение не ответило: ${result.legs.map((l) => `${l.provider}:${l.outcome}`).join(', ')}` });
          continue;
        }
        const verdict = parseUserPhotoVerdict(result);
        const { decision, reason: why2 } = decideUserPhoto(verdict, duplicateOf);
        const upd = await pool.query(
          `UPDATE user_place_photos
              SET vision_verdict = $2::jsonb, agent_decision = $3::text, agent_reason = $4::text, agent_at = NOW(),
                  status = CASE WHEN $3::text IN ('approved', 'rejected') THEN $3::text ELSE status END,
                  reviewed_at = CASE WHEN $3::text IN ('approved', 'rejected') THEN NOW() ELSE reviewed_at END
            WHERE id::text = $1 AND status = 'pending'`,
          [c.id, JSON.stringify(verdict), decision, why2],
        );
        if ((upd.rowCount ?? 0) === 0) {
          failed.push({ id: c.id, place: c.place, reason: 'пока агент смотрел, решение принял человек — не трогаю' });
          continue;
        }
        done.push({ id: c.id, place: c.place, decision, reason: why2, depicts: verdict.depicts, by: verdict.model });
      } catch (err) {
        failed.push({ id: c.id, place: c.place, reason: err instanceof Error ? err.message.slice(0, 200) : 'ошибка обработки' });
      }
    }

    const word = { approved: 'одобрено', rejected: 'отклонено', human: 'человеку' } as const;
    const notified = await notifyAdmin([
      ...done.map((d) => `• ${escapeHtml(String(d.place))}: ${word[d.decision as keyof typeof word]} — ${escapeHtml(String(d.reason))}`),
      ...failed.map((f) => `• ${escapeHtml(f.place)}: не смог — ${escapeHtml(f.reason)}`),
    ]);

    // Телеметрия: реестр (agentId 'user-photo-moderate') ждёт отметку
    // прогона; сухой прогон её не пишет — он ничего не делает.
    void logAgentRun({
      agent_id: 'user-photo-moderate',
      status: failed.length === 0 ? 'success' : done.length > 0 ? 'partial' : 'failed',
      started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: rows.length,
      items_created: done.length,
      errors_count: failed.length,
      error_msg: failed.length > 0 ? failed.slice(0, 3).map((f) => f.reason).join('; ') : undefined,
    });

    return NextResponse.json({ ok: true, dry_run: false, reason, notified, moderated: done.length, failed_count: failed.length, done, failed });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[user-photo-moderate] партия не выполнилась:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ ok: false, error: 'Партия не выполнилась', sqlstate: e?.code ?? null }, { status: 500 });
  }
}
