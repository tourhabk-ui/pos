/**
 * /api/cron/images-oversize — тяжёлые снимки: перепись (GET) и удаление (POST).
 *
 * ПОВОД. Сухой прогон переезда в S3 (prod-check run 43) показал не просто
 * «много байт», а перекос: первые два снимка по 15,4 МБ, третий 13,6, четвёртый
 * 9,3 — при среднем по таблице 641 КБ. Решение владельца: «удалить, 15 много».
 *
 * ПОЧЕМУ ПЯТНАДЦАТЬ МЕГАБАЙТ — ЭТО СЛЕД, А НЕ ПРОСТО ВЕС. Оба живых пишущих
 * пути прогоняют файл через sharp перед записью: `admin/places/[id]/photo` и
 * `wiki-candidates` режут до 1280x720 и жмут mozjpeg q85. Столько байт с этого
 * конвейера выйти не может. Значит тяжёлая строка пришла НЕ оттуда — осталась
 * от поры, когда сжатия не было, или от генератора картинок. Отсюда главный
 * вопрос переписи: не «сколько весит», а `model` — чем эта строка заведена.
 *
 * ЦЕНА УДАЛЕНИЯ. У таблицы уникальный индекс по `route_id` (миграция 107), и
 * оба писателя ходят через `ON CONFLICT (route_id) DO UPDATE`. Снимок у места
 * РОВНО ОДИН — «другого фото» не существует. Удалить строку значит оставить
 * место с градиентной заглушкой навсегда: восстановить байты будет неоткуда.
 * Поэтому перепись отвечает не только весом, но и тем, что именно исчезнет:
 * имя места, видимо ли оно, есть ли у снимка автор и лицензия.
 *
 * РАЗДЕЛЕНИЕ ПО МЕТОДУ. GET — только перепись, не удаляет ни строки. POST
 * удаляет, и три вещи у него обязательны и без умолчаний: порог `min_bytes`,
 * причина и явный `dry_run: false`. Порога по умолчанию нет намеренно: удалять
 * по границе, которую выдумал код, — то же враньё, что и любой другой
 * невыясненный факт (§4.0). Границу называет человек, посмотрев перепись.
 *
 * ЧЕГО УДАЛЕНИЕ НЕ СДЕЛАЕТ — и обещать этого нельзя. DELETE в PostgreSQL не
 * возвращает место операционной системе: страницы помечаются свободными и
 * годятся под будущие строки ЭТОЙ таблицы, но файл на диске не уменьшается, и
 * `pg_database_size` после чистки покажет прежнее число. Уменьшает файл только
 * `VACUUM FULL`, а он берёт исключительную блокировку и на время работы
 * требует места под вторую копию таблицы. Здесь это особенно важно: снимков
 * прибавляется примерно по одному на новое место, то есть освобождённые
 * страницы переиспользуются годами. Настоящую разгрузку даёт переезд в S3
 * (`images-to-s3`), а удаление — это про то, чтобы не возить в S3 мусор.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

/** Сколько самых тяжёлых показывать в переписи. */
const DETAIL_LIMIT = 25;

const BodySchema = z.object({
  reason:    z.string().min(10, 'Причина обязательна: зачем удаляем снимки'),
  // Без умолчания: границу называет человек, а не код.
  min_bytes: z.number().int().min(1, 'Порог обязателен: с какого веса удаляем'),
  limit:     z.number().int().min(1).max(MAX_BATCH).default(MAX_BATCH),
  dry_run:   z.boolean().default(true),
});

interface DetailRow {
  id: string;
  route_id: string;
  size_bytes: string;
  mime_type: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  author: string | null;
  license: string | null;
  created_at: string;
  place_name: string | null;
  place_visible: boolean | null;
  route_title: string | null;
  route_visible: boolean | null;
}

/**
 * Что исчезнет вместе со строкой. Имя места важнее идентификатора: по UUID
 * решение «удалять или нет» не принимается, а по «Долина гейзеров, фото с
 * автором и лицензией» — принимается.
 *
 * `subject_kind` отвечает и третьим исходом: снимок может висеть на
 * `route_id`, которому не соответствует ни место, ни маршрут (следы слияний и
 * чисток). Такая строка — сирота, и это не то же самое, что «место скрыто».
 */
function describe(r: DetailRow) {
  const subjectKind = r.place_name != null ? 'place'
    : r.route_title != null ? 'route'
    : 'orphan';
  return {
    id: r.id,
    route_id: r.route_id,
    size_kb: Math.round(Number(r.size_bytes) / 1024),
    // Чем строка заведена. У живых писателей это wikimedia / manual-upload;
    // всё прочее пришло не через sharp и потому и весит столько.
    model: r.model,
    mime: r.mime_type,
    declared_size: r.width != null && r.height != null ? `${r.width}x${r.height}` : null,
    created_at: r.created_at,
    subject_kind: subjectKind,
    subject_name: r.place_name ?? r.route_title,
    subject_visible: r.place_name != null ? r.place_visible : r.route_visible,
    // Кредит автора — признак настоящей фотографии под лицензией, а не
    // сгенерированной картинки. Для решения об удалении это разные вещи.
    credited: r.author != null || r.license != null,
    author: r.author,
    license: r.license,
  };
}

/** Перепись: раскладка по весу, раскладка по происхождению, самые тяжёлые. */
async function census() {
  const [{ rows: buckets }, { rows: byModel }, { rows: details }] = await Promise.all([
    pool.query<{ bucket: string; n: string; mb: string }>(
      `SELECT CASE
                WHEN OCTET_LENGTH(image_data) >= 8388608 THEN 'a_8mb_plus'
                WHEN OCTET_LENGTH(image_data) >= 4194304 THEN 'b_4_8mb'
                WHEN OCTET_LENGTH(image_data) >= 2097152 THEN 'c_2_4mb'
                WHEN OCTET_LENGTH(image_data) >= 1048576 THEN 'd_1_2mb'
                WHEN OCTET_LENGTH(image_data) >=  524288 THEN 'e_512kb_1mb'
                ELSE 'f_under_512kb'
              END AS bucket,
              COUNT(*)::text AS n,
              ROUND(SUM(OCTET_LENGTH(image_data)) / 1048576.0, 1)::text AS mb
         FROM ai_route_images
        WHERE image_data IS NOT NULL
        GROUP BY 1
        ORDER BY 1`,
    ),
    pool.query<{ model: string | null; n: string; mb: string; avg_kb: string }>(
      `SELECT model,
              COUNT(*)::text AS n,
              ROUND(SUM(OCTET_LENGTH(image_data)) / 1048576.0, 1)::text AS mb,
              ROUND(AVG(OCTET_LENGTH(image_data)) / 1024.0)::text AS avg_kb
         FROM ai_route_images
        WHERE image_data IS NOT NULL
        GROUP BY model
        ORDER BY SUM(OCTET_LENGTH(image_data)) DESC`,
    ),
    pool.query<DetailRow>(
      `SELECT i.id::text, i.route_id::text,
              OCTET_LENGTH(i.image_data)::text AS size_bytes,
              i.mime_type, i.model, i.width, i.height, i.author, i.license,
              i.created_at::text,
              p.name  AS place_name, p.is_visible  AS place_visible,
              kr.title AS route_title, kr.is_visible AS route_visible
         FROM ai_route_images i
         LEFT JOIN places p ON p.ark_id = i.route_id
         LEFT JOIN kamchatka_routes kr ON kr.id = i.route_id OR kr.ark_id = i.route_id
        WHERE i.image_data IS NOT NULL
        ORDER BY OCTET_LENGTH(i.image_data) DESC
        LIMIT $1`,
      [DETAIL_LIMIT],
    ),
  ]);

  return {
    by_size: buckets.map(b => ({
      bucket: b.bucket.slice(2),
      count: Number(b.n),
      total_mb: Number(b.mb),
    })),
    by_model: byModel.map(m => ({
      model: m.model,
      count: Number(m.n),
      total_mb: Number(m.mb),
      avg_kb: Number(m.avg_kb),
    })),
    heaviest: details.map(describe),
  };
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const data = await census();
    return NextResponse.json({
      ok: true,
      probe: 'images_oversize_v1',
      method: 'GET',
      ...data,
      // Ноль строк — отказ переписи, а не «тяжёлых снимков нет» (§4.0).
      meaningful: data.heaviest.length > 0,
      note: 'только перепись: GET ничего не удаляет. Удаление — POST с порогом, причиной и явным dry_run: false',
      cost_note: 'снимок у места ровно один (уникальный индекс по route_id): удаление оставляет место с градиентом навсегда',
      space_note: 'DELETE не уменьшает файл на диске: страницы освобождаются под будущие строки этой же таблицы, pg_database_size не упадёт. Разгружает базу переезд в S3, а не удаление',
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-oversize] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_oversize_v1', error: 'перепись не выполнена', sqlstate: code },
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
    const { rows } = await pool.query<DetailRow>(
      `SELECT i.id::text, i.route_id::text,
              OCTET_LENGTH(i.image_data)::text AS size_bytes,
              i.mime_type, i.model, i.width, i.height, i.author, i.license,
              i.created_at::text,
              p.name  AS place_name, p.is_visible  AS place_visible,
              kr.title AS route_title, kr.is_visible AS route_visible
         FROM ai_route_images i
         LEFT JOIN places p ON p.ark_id = i.route_id
         LEFT JOIN kamchatka_routes kr ON kr.id = i.route_id OR kr.ark_id = i.route_id
        WHERE i.image_data IS NOT NULL
          AND OCTET_LENGTH(i.image_data) >= $1
        ORDER BY OCTET_LENGTH(i.image_data) DESC
        LIMIT $2`,
      [min_bytes, limit],
    );
    const targets = rows.map(describe);

    if (dry_run) {
      return NextResponse.json({
        ok: true,
        probe: 'images_oversize_v1',
        dry_run: true,
        reason,
        min_bytes,
        would_delete: targets,
        would_free_kb: targets.reduce((s, t) => s + t.size_kb, 0),
      });
    }

    const deleted: typeof targets = [];
    // «Не смог» отдельным списком: строка, которую не удалось удалить, должна
    // быть названа, иначе отказ неотличим от пустой партии.
    const failed: Array<{ id: string; reason: string }> = [];

    for (const t of targets) {
      try {
        // Порог повторён в самом DELETE: между выборкой и удалением снимок мог
        // быть заменён лёгким через админку, и тогда удалять его уже незачем.
        const res = await pool.query(
          `DELETE FROM ai_route_images
            WHERE id = $1::uuid
              AND image_data IS NOT NULL
              AND OCTET_LENGTH(image_data) >= $2`,
          [t.id, min_bytes],
        );
        if ((res.rowCount ?? 0) > 0) deleted.push(t);
        else failed.push({ id: t.id, reason: 'строка изменилась между переписью и удалением — не тронута' });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[images-oversize] снимок ${t.id} не удалён, SQLSTATE ${code}:`, msg);
        failed.push({ id: t.id, reason: `${code}: ${msg.slice(0, 160)}` });
      }
    }

    return NextResponse.json({
      ok: true,
      probe: 'images_oversize_v1',
      dry_run: false,
      reason,
      min_bytes,
      deleted_count: deleted.length,
      failed_count: failed.length,
      freed_kb: deleted.reduce((s, d) => s + d.size_kb, 0),
      deleted,
      failed,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-oversize] разбор не выполнен, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_oversize_v1', error: 'разбор не выполнен', sqlstate: code },
      { status: 503 },
    );
  }
}
