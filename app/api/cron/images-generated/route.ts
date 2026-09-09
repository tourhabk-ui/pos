/**
 * /api/cron/images-generated — удалить СГЕНЕРИРОВАННЫЕ картинки мест.
 *
 * ПОВОД. Перепись 09.09 с прода показала, чего никто не ожидал: почти
 * половина веса таблицы — не фотографии. `qwen-image` — 98 строк на 189,9 МБ
 * (в среднем по два мегабайта на картинку), `pollinations-flux` — ещё 75
 * строк на 7,2 МБ. Вместе 173 строки и 197 МБ из 421.
 *
 * Показывать их не следует по решению владельца 2026-07-17 — «честный
 * градиент вместо AI-фото». Карточка места это уже соблюдает (`thumb_url`
 * отдаётся только для `wikimedia` и `manual-upload`), но байты остались в
 * базе, и переезд в S3 повёз бы их первыми: они тяжелее всего.
 *
 * Решение владельца 09.09 по этой переписи: реальные пережать
 * (`images-recompress`), сгенерированные удалить. Здесь — второе.
 *
 * ЧТО УДАЛЯТЬ, РОУТ ЗНАЕТ САМ. Список родов заморожен в коде
 * (`lib/images/origin.ts`) и НЕ принимается из тела запроса. Это главное
 * свойство безопасности: нельзя опечаткой в параметре стереть `real-photo`,
 * потому что параметра нет. Условие повторено и в самом DELETE — между
 * планом и удалением снимок мог быть заменён настоящим через админку.
 *
 * Правила партии прежние: `dry_run` по умолчанию, партия не больше 10,
 * `reason` обязателен и без умолчания.
 *
 * ЧЕГО УДАЛЕНИЕ НЕ СДЕЛАЕТ. Файл на диске не уменьшится: `DELETE` освобождает
 * страницы под будущие строки этой же таблицы, `pg_database_size` покажет
 * прежнее число. Смысл не в дисковом месте, а в том, чтобы не возить в S3 то,
 * что решено не показывать, и чтобы перепись перестала называть мусор
 * половиной содержимого.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { GENERATED_MODELS } from '@/lib/images/origin';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

const BodySchema = z.object({
  reason:  z.string().min(10, 'Причина обязательна: зачем удаляем'),
  limit:   z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run: z.boolean().default(true),
});

interface Row {
  id: string;
  size_bytes: string;
  model: string | null;
  place_name: string | null;
  route_title: string | null;
}

/** Сколько осталось и что уедет следующей партией. */
async function plan(limit: number) {
  const models = [...GENERATED_MODELS];
  const [{ rows }, { rows: left }] = await Promise.all([
    pool.query<Row>(
      `SELECT i.id::text,
              OCTET_LENGTH(i.image_data)::text AS size_bytes,
              i.model,
              p.name   AS place_name,
              kr.title AS route_title
         FROM ai_route_images i
         LEFT JOIN places p ON p.ark_id = i.route_id
         LEFT JOIN kamchatka_routes kr ON kr.id = i.route_id OR kr.ark_id = i.route_id
        WHERE i.model = ANY($1::text[])
        ORDER BY OCTET_LENGTH(i.image_data) DESC NULLS LAST
        LIMIT $2`,
      [models, limit],
    ),
    pool.query<{ model: string; n: string; mb: string }>(
      `SELECT model, COUNT(*)::text AS n,
              ROUND(COALESCE(SUM(OCTET_LENGTH(image_data)), 0) / 1048576.0, 1)::text AS mb
         FROM ai_route_images
        WHERE model = ANY($1::text[])
        GROUP BY model
        ORDER BY model`,
      [models],
    ),
  ]);
  const remaining = left.reduce((s, r) => s + Number(r.n), 0);
  return {
    rows,
    remaining,
    remaining_mb: Math.round(left.reduce((s, r) => s + Number(r.mb), 0) * 10) / 10,
    by_model: left.map(r => ({ model: r.model, count: Number(r.n), total_mb: Number(r.mb) })),
    items: rows.map(r => ({
      id: r.id,
      size_kb: Math.round(Number(r.size_bytes ?? '0') / 1024),
      model: r.model,
      subject: r.place_name ?? r.route_title,
    })),
  };
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const p = await plan(MAX_BATCH);
    return NextResponse.json({
      ok: true,
      probe: 'images_generated_v1',
      dry_run: true,
      method: 'GET',
      // Роды перечислены в ответе, чтобы читатель видел, что именно попадёт
      // под удаление, не заглядывая в исходники.
      models: [...GENERATED_MODELS],
      remaining: p.remaining,
      remaining_mb: p.remaining_mb,
      by_model: p.by_model,
      would_delete: p.items,
      meaningful: p.by_model.length > 0,
      note: 'только план: GET ничего не удаляет. Удаление — POST с причиной и явным dry_run: false',
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-generated] план не собран, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_generated_v1', error: 'план не собран', sqlstate: code },
      { status: 503 },
    );
  }
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
    const p = await plan(limit);

    if (dry_run) {
      return NextResponse.json({
        ok: true, probe: 'images_generated_v1', dry_run: true, reason,
        models: [...GENERATED_MODELS],
        remaining: p.remaining, remaining_mb: p.remaining_mb,
        by_model: p.by_model, would_delete: p.items,
      });
    }

    const deleted: typeof p.items = [];
    const failed: Array<{ id: string; reason: string }> = [];

    for (const item of p.items) {
      try {
        // Род повторён в самом DELETE: между планом и удалением снимок мог
        // быть заменён настоящей фотографией через админку.
        const res = await pool.query(
          `DELETE FROM ai_route_images
            WHERE id = $1::uuid AND model = ANY($2::text[])`,
          [item.id, [...GENERATED_MODELS]],
        );
        if ((res.rowCount ?? 0) > 0) deleted.push(item);
        else failed.push({ id: item.id, reason: 'строка изменилась между планом и удалением — не тронута' });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[images-generated] снимок ${item.id} не удалён, SQLSTATE ${code}:`, msg);
        failed.push({ id: item.id, reason: `${code}: ${msg.slice(0, 160)}` });
      }
    }

    return NextResponse.json({
      ok: true,
      probe: 'images_generated_v1',
      dry_run: false,
      reason,
      deleted_count: deleted.length,
      failed_count: failed.length,
      freed_kb: deleted.reduce((s, d) => s + d.size_kb, 0),
      deleted,
      failed,
      // Сколько было ДО этой партии: следующий прогон должен увидеть меньше,
      // и по этому числу видно, движется ли разбор.
      remaining_before: p.remaining,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-generated] разбор не выполнен, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_generated_v1', error: 'разбор не выполнен', sqlstate: code },
      { status: 503 },
    );
  }
}
