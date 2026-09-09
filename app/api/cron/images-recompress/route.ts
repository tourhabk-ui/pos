/**
 * /api/cron/images-recompress — пережать тяжёлые СНЯТЫЕ снимки, не потеряв их.
 *
 * ПОВОД. Перепись 09.09 нашла четыре снимка тяжелее восьми мегабайт (52,5 МБ
 * на четверых) и сто с лишним в диапазоне 1-4 МБ. Два самых тяжёлых — по
 * 15,4 МБ, оба `real-photo`, и один из них Халактырский пляж: видимое место,
 * снимок единственный. Удалить такой значит оставить пляж с градиентом
 * навсегда — восстановить неоткуда (уникальный индекс по route_id, «другого
 * фото» не бывает).
 *
 * Решение владельца: реальные пережать, сгенерированные удалить. Удаление
 * генерации — соседний роут `images-generated`; здесь только пережатие, и
 * генерации оно не касается вовсе (`lib/images/origin.ts`).
 *
 * ПОЧЕМУ ЭТО РАБОТАЕТ. Оба живых писателя уже гонят файл через sharp: режут и
 * жмут mozjpeg q85. Пятнадцать мегабайт с этого конвейера выйти не могут —
 * значит тяжёлые строки его не проходили. Тот же конвейер, применённый к ним,
 * даёт порядок 200-400 КБ, то есть 98% веса при сохранённой фотографии.
 *
 * ГДЕ ОТЛИЧИЕ ОТ ПИСАТЕЛЕЙ — и оно намеренное. Те режут `fit: 'cover'`, то
 * есть КАДРИРУЮТ под 16:9: для новой загрузки это выбор кадра в момент
 * загрузки. Здесь снимок уже лежит и уже показывался, и обрезать ему верх с
 * низом задним числом — потеря содержимого ради байтов, которых это почти не
 * добавит. Поэтому `fit: 'inside'` без увеличения: кадр целиком, вписан в
 * 1280x720.
 *
 * ПОРЯДОК ДЕЙСТВИЙ — и он не переставляется:
 *
 *   1. пережать;
 *   2. ПРОЧИТАТЬ результат обратно (`sharp().metadata()`) — байты обязаны
 *      быть валидным изображением с ненулевыми сторонами;
 *   3. убедиться, что стало ЛЕГЧЕ;
 *   4. только теперь записать, и только если строка не менялась.
 *
 * Второй шаг не формальность: `toBuffer()` вернул буфер — это ещё не значит,
 * что в нём картинка. Записать нечитаемые байты поверх единственного снимка
 * места — то же самое, что его удалить, только тише.
 *
 * Заодно чинится ложь в схеме: у пятнадцатимегабайтных строк в `width`/
 * `height` записано 1280x720, чего в байтах заведомо нет. После пережатия там
 * будут настоящие стороны результата.
 *
 * Правила партии те же, что у остальных пишущих разборов: `dry_run` по
 * умолчанию, партия не больше 10, `reason` обязателен и без умолчания,
 * `min_bytes` обязателен и без умолчания — границу называет человек.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import sharp from 'sharp';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { GENERATED_MODELS } from '@/lib/images/origin';

export const dynamic     = 'force-dynamic';
export const maxDuration = 300;

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

/** Те же величины, что у обоих писателей: канон платформы, а не свой вкус. */
const TARGET_WIDTH  = 1280;
const TARGET_HEIGHT = 720;
const JPEG_QUALITY  = 85;

const BodySchema = z.object({
  reason:    z.string().min(10, 'Причина обязательна: зачем трогаем снимки'),
  min_bytes: z.number().int().min(1, 'Порог обязателен: с какого веса пережимаем'),
  limit:     z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run:   z.boolean().default(true),
});

interface Row {
  id: string;
  size_bytes: string;
  image_data: Buffer | null;
  model: string | null;
  place_name: string | null;
  route_title: string | null;
}

/**
 * Кандидаты: тяжёлые и НЕ сгенерированные.
 *
 * Список родов приходит из замороженного `GENERATED_MODELS`, а не из тела
 * запроса. `model IS NULL OR model <> ALL(...)` — снимок без указанного рода
 * считается снятым и потому пережимается, а не удаляется: сторона ошибки
 * выбрана в пользу сохранения.
 */
async function candidates(minBytes: number, limit: number) {
  const { rows } = await pool.query<Row>(
    `SELECT i.id::text,
            OCTET_LENGTH(i.image_data)::text AS size_bytes,
            i.image_data, i.model,
            p.name   AS place_name,
            kr.title AS route_title
       FROM ai_route_images i
       LEFT JOIN places p ON p.ark_id = i.route_id
       LEFT JOIN kamchatka_routes kr ON kr.id = i.route_id OR kr.ark_id = i.route_id
      WHERE i.image_data IS NOT NULL
        AND OCTET_LENGTH(i.image_data) >= $1
        AND (i.model IS NULL OR i.model <> ALL($2::text[]))
      ORDER BY OCTET_LENGTH(i.image_data) DESC
      LIMIT $3`,
    [minBytes, [...GENERATED_MODELS], limit],
  );
  const { rows: left } = await pool.query<{ pending: string; pending_mb: string }>(
    `SELECT COUNT(*)::text AS pending,
            ROUND(COALESCE(SUM(OCTET_LENGTH(image_data)), 0) / 1048576.0, 1)::text AS pending_mb
       FROM ai_route_images
      WHERE image_data IS NOT NULL
        AND OCTET_LENGTH(image_data) >= $1
        AND (model IS NULL OR model <> ALL($2::text[]))`,
    [minBytes, [...GENERATED_MODELS]],
  );
  return {
    rows,
    pending: Number(left[0]?.pending ?? '0'),
    pendingMb: Number(left[0]?.pending_mb ?? '0'),
    plan: rows.map((r) => ({
      id: r.id,
      size_kb: Math.round(Number(r.size_bytes) / 1024),
      model: r.model,
      subject: r.place_name ?? r.route_title,
    })),
  };
}

/** Порог для GET: только чтобы план был о чём-то. Запись его не использует. */
const PLAN_MIN_BYTES = 1048576;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { plan, pending, pendingMb } = await candidates(PLAN_MIN_BYTES, MAX_BATCH);
    return NextResponse.json({
      ok: true,
      probe: 'images_recompress_v1',
      dry_run: true,
      method: 'GET',
      plan_min_bytes: PLAN_MIN_BYTES,
      pending,
      pending_mb: pendingMb,
      would_recompress: plan,
      meaningful: plan.length > 0,
      note: 'только план: GET ничего не пишет. Пережатие — POST с порогом, причиной и явным dry_run: false',
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-recompress] план не собран, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_recompress_v1', error: 'план не собран', sqlstate: code },
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
  const { reason, min_bytes, limit, dry_run } = parsed.data;

  try {
    const { rows, plan, pending, pendingMb } = await candidates(min_bytes, limit);

    if (dry_run) {
      return NextResponse.json({
        ok: true, probe: 'images_recompress_v1', dry_run: true, reason,
        min_bytes, pending, pending_mb: pendingMb, would_recompress: plan,
      });
    }

    const done: Array<{ id: string; subject: string | null; was_kb: number; now_kb: number; size: string }> = [];
    // «Не смог» отдельным списком: снимок остался тяжёлым, и по отчёту должно
    // быть видно какой и почему — иначе отказ неотличим от пустой партии.
    const failed: Array<{ id: string; reason: string }> = [];

    for (const r of rows) {
      const item = plan.find(p => p.id === r.id)!;
      if (!r.image_data) { failed.push({ id: r.id, reason: 'байтов нет' }); continue; }

      try {
        const out = await sharp(r.image_data, { failOn: 'truncated' })
          // EXIF-ориентация применяется ДО вписывания: иначе портретный снимок
          // вписался бы как лежащий и повернулся уже после.
          .rotate()
          .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
          .toBuffer();

        // ПРОВЕРКА ДО ЗАПИСИ. Буфер вернулся — это ещё не изображение.
        const meta = await sharp(out).metadata();
        if (!meta.width || !meta.height) {
          failed.push({ id: r.id, reason: 'результат не читается как изображение' });
          continue;
        }
        if (out.length >= r.image_data.length) {
          failed.push({
            id: r.id,
            reason: `не стало легче: было ${r.image_data.length}, стало ${out.length}`,
          });
          continue;
        }

        // Условие по прежнему весу — оптимистическая блокировка: снимок мог
        // быть заменён через админку между выборкой и записью, и тогда
        // переписывать его нашим результатом нельзя.
        const res = await pool.query(
          `UPDATE ai_route_images
              SET image_data = $1, width = $2, height = $3, mime_type = 'image/jpeg'
            WHERE id = $4::uuid
              AND OCTET_LENGTH(image_data) = $5`,
          [out, meta.width, meta.height, r.id, r.image_data.length],
        );
        if ((res.rowCount ?? 0) === 0) {
          failed.push({ id: r.id, reason: 'снимок изменился между планом и записью — не тронут' });
          continue;
        }
        done.push({
          id: r.id,
          subject: item.subject,
          was_kb: item.size_kb,
          now_kb: Math.round(out.length / 1024),
          size: `${meta.width}x${meta.height}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[images-recompress] снимок ${r.id} не пережат:`, msg);
        failed.push({ id: r.id, reason: msg.slice(0, 200) });
      }
    }

    return NextResponse.json({
      ok: true,
      probe: 'images_recompress_v1',
      dry_run: false,
      reason,
      min_bytes,
      recompressed_count: done.length,
      failed_count: failed.length,
      freed_kb: done.reduce((s, d) => s + (d.was_kb - d.now_kb), 0),
      recompressed: done,
      failed,
      pending_before: pending,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-recompress] разбор не выполнен, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_recompress_v1', error: 'разбор не выполнен', sqlstate: code },
      { status: 503 },
    );
  }
}
