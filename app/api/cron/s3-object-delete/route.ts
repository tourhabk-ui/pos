/**
 * POST /api/cron/s3-object-delete — удалить брошенный снимок места из хранилища.
 *
 * Правила и повод — lib/storage/orphan-delete.ts. Коротко:
 *   - поимённо, только ключи `places/<uuid>/<файл>`, партия не больше 10;
 *   - причина обязательна и уходит в лог вместе с ключом и размером;
 *   - объект, на который ссылается хоть одна строка базы, не удаляется;
 *     проверка, которая не выполнилась, — отказ, а не «ссылок нет»;
 *   - dry_run по умолчанию: план с размером объекта, потом удаление;
 *   - после удаления объект спрашивается ещё раз: «удалено» говорится
 *     только тогда, когда хранилище отвечает 404, а не когда команда
 *     ушла без ошибки.
 *
 * Запускает `.github/workflows/s3-object-delete.yml` по маркеру.
 * Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { deleteFromS3, isS3Configured, s3PublicBase } from '@/lib/storage/s3';
import {
  DELETE_BATCH_MAX, isPlaceImageKey, referenceCountSql, type DeleteVerdict,
} from '@/lib/storage/orphan-delete';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  reason: z.string().min(8, 'reason обязателен: почему объект удаляется').max(300),
  keys: z.array(z.string().min(1).max(200)).min(1).max(DELETE_BATCH_MAX),
});

const HEAD_TIMEOUT_MS = 10_000;

type Presence = { present: true; bytes: number | null } | { present: false } | { error: string };

/** Есть ли объект в хранилище — по публичному адресу, тем же путём, что видит турист. */
async function headObject(key: string): Promise<Presence> {
  try {
    const res = await fetch(`${s3PublicBase()}/${key}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (res.status === 404) return { present: false };
    if (!res.ok) return { error: `хранилище ответило ${res.status}` };
    const len = Number(res.headers.get('content-length'));
    return { present: true, bytes: Number.isFinite(len) && len > 0 ? len : null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function referencedBy(key: string): Promise<string[]> {
  const { rows } = await pool.query<{ col: string; n: number }>(referenceCountSql(), [key]);
  return rows.filter((r) => r.n > 0).map((r) => `${r.col} (${r.n})`);
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isS3Configured) {
    return NextResponse.json({ error: 'Хранилище не настроено на этом сервере' }, { status: 503 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : 'Тело запроса не JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const results: DeleteVerdict[] = [];
  for (const key of body.keys) {
    if (!isPlaceImageKey(key)) {
      results.push({ key, outcome: 'refused_bad_key' });
      continue;
    }

    let refs: string[];
    try {
      refs = await referencedBy(key);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      console.error('[s3-object-delete] проверка ссылок не выполнилась:', key, code ?? '', err instanceof Error ? err.message : err);
      results.push({ key, outcome: 'refused_check_failed', reason: `проверка ссылок не выполнилась${code ? ` (${String(code)})` : ''}` });
      continue;
    }
    if (refs.length > 0) {
      results.push({ key, outcome: 'refused_referenced', referencedBy: refs });
      continue;
    }

    const before = await headObject(key);
    if ('error' in before) {
      results.push({ key, outcome: 'refused_check_failed', reason: `наличие объекта не проверено: ${before.error}` });
      continue;
    }
    if (!before.present) {
      results.push({ key, outcome: 'already_absent' });
      continue;
    }
    if (body.dry_run) {
      results.push({ key, outcome: 'would_delete', bytes: before.bytes });
      continue;
    }

    try {
      await deleteFromS3(key);
    } catch (err) {
      console.error('[s3-object-delete] удаление отказало:', key, err instanceof Error ? err.message : err);
      results.push({ key, outcome: 'delete_unverified', reason: `команда удаления отказала: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const after = await headObject(key);
    if ('present' in after && !after.present) {
      console.warn('[s3-object-delete] удалён', key, before.bytes ?? '?', 'байт — причина:', body.reason);
      results.push({ key, outcome: 'deleted', bytes: before.bytes });
    } else {
      results.push({
        key,
        outcome: 'delete_unverified',
        reason: 'error' in after ? `повторная проверка не выполнилась: ${after.error}` : 'объект после удаления всё ещё отдаётся',
      });
    }
  }

  const count = (o: DeleteVerdict['outcome']) => results.filter((r) => r.outcome === o).length;
  return NextResponse.json({
    dry_run: body.dry_run,
    reason: body.reason,
    results,
    summary: {
      would_delete: count('would_delete'),
      deleted: count('deleted'),
      already_absent: count('already_absent'),
      refused: results.filter((r) => r.outcome.startsWith('refused')).length,
      unverified: count('delete_unverified'),
    },
  });
}
