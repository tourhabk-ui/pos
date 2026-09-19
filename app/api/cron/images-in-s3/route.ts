/**
 * GET /api/cron/images-in-s3 — перепись снимков, которые УЖЕ живут в
 * хранилище. Только чтение: ни одного UPDATE/INSERT/DELETE ни при каком
 * аргументе.
 *
 * ПОВОД. 19.09 владелец попросил список всех перевезённых снимков. Оказалось,
 * что дать его неоткуда: актуатор `images-repack` печатает в отчёт ТОЛЬКО
 * последний ответ партии — десять строк из двухсот пятидесяти. Промежуточные
 * ответы он перезаписывает в один и тот же файл, и после прогона их нет ни в
 * логе, ни где-либо ещё.
 *
 * ЭТО ТА ЖЕ БОЛЕЗНЬ, ЧТО В §4: результат работы существовал только в виде
 * счётчика. «Перевезено 250» — число, которому нечем возразить: по нему
 * нельзя ни проверить, что уехало именно то, ни найти конкретный снимок.
 * Состояние надо спрашивать у данных, а не у отчёта о прогоне.
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ЗНАЕТ, и это важно сказать вслух. Она отвечает «что лежит
 * в хранилище СЕЙЧАС», а не «что увёз прогон номер семь»: у переезда нет
 * отметки времени. Столбца «когда переехал» в `ai_route_images` нет вовсе,
 * `created_at` при переносе не трогается (и правильно — это дата снимка, а
 * не дата переезда). Значит разделить партии по прогонам нечем, и выдавать
 * часть списка за «те самые 250» было бы выдумкой (§4.0).
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Страница списка. Потолок есть, чтобы ответ пролезал в пробу целиком. */
const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 200;

interface ItemRow {
  id: string;
  s3_key: string;
  model: string | null;
  author: string | null;
  subject_name: string | null;
  subject_kind: string;
}

/**
 * Что лежит в хранилище. Имя места важнее ключа: по ключу человек снимок не
 * опознает, по «Вулкан Горелый» — опознает сразу.
 *
 * Размера здесь нет ВОВСЕ, и это не упущение: байтов в базе уже не осталось,
 * вес объекта знает только хранилище, а ноль читался бы как «пустой файл».
 * Отсутствие поля честнее выдуманного числа.
 */
async function listMoved(limit: number, offset: number) {
  const { rows } = await pool.query<ItemRow>(
    `SELECT i.id::text,
            i.s3_key,
            i.model,
            i.author,
            COALESCE(p.name, kr.title) AS subject_name,
            CASE WHEN p.name IS NOT NULL THEN 'place'
                 WHEN kr.title IS NOT NULL THEN 'route'
                 ELSE 'orphan' END AS subject_kind
       FROM ai_route_images i
       LEFT JOIN places p ON p.ark_id::text = i.route_id::text
       LEFT JOIN kamchatka_routes kr
              ON kr.id::text = i.route_id::text OR kr.ark_id::text = i.route_id::text
      WHERE i.s3_key IS NOT NULL
      ORDER BY COALESCE(p.name, kr.title) NULLS LAST, i.id
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

/** Счётчики: сколько уехало, сколько ещё байтами, и раскладка по роду. */
async function counts() {
  const [{ rows: totals }, { rows: byModel }] = await Promise.all([
    pool.query<{ in_s3: string; in_db: string; neither: string }>(
      `SELECT COUNT(*) FILTER (WHERE s3_key IS NOT NULL)::text AS in_s3,
              COUNT(*) FILTER (WHERE image_data IS NOT NULL)::text AS in_db,
              -- Ни байтов, ни ключа: строка есть, снимка нет. Это не ноль и
              -- не успех — это состояние, которое обязано быть видно.
              COUNT(*) FILTER (WHERE image_data IS NULL AND s3_key IS NULL)::text AS neither
         FROM ai_route_images`,
    ),
    pool.query<{ model: string | null; n: string }>(
      `SELECT model, COUNT(*)::text AS n
         FROM ai_route_images
        WHERE s3_key IS NOT NULL
        GROUP BY model
        ORDER BY COUNT(*) DESC`,
    ),
  ]);
  const t = totals[0];
  return {
    in_s3:   Number(t?.in_s3 ?? 0),
    in_db:   Number(t?.in_db ?? 0),
    neither: Number(t?.neither ?? 0),
    by_model: byModel.map(m => ({ model: m.model, count: Number(m.n) })),
  };
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url    = new URL(req.url);
  const part   = url.searchParams.get('part') ?? 'both';
  const limit  = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const c = await counts();
    const items = part === 'summary' ? [] : await listMoved(limit, offset);

    return NextResponse.json({
      ok: true,
      probe: 'images_in_s3_v1',
      method: 'GET',
      ...c,
      page: { limit, offset, returned: items.length, has_more: offset + items.length < c.in_s3 },
      // Компактной строкой: имя места, род снимка, автор. Ключ рядом — по
      // нему объект находится в хранилище, но читает человек имя.
      items: part === 'summary' ? undefined : items.map(r => ({
        name:   r.subject_name ?? '(ни места, ни маршрута)',
        kind:   r.subject_kind,
        model:  r.model,
        author: r.author,
        key:    r.s3_key,
      })),
      scope_note: 'что лежит в хранилище СЕЙЧАС. Разделить по прогонам нечем: отметки времени переезда в таблице нет, created_at — дата снимка, а не переезда',
      write_note: 'только перепись, роут не пишет вовсе',
      // Ноль строк при ненулевом in_s3 — отказ выборки, а не «ничего нет».
      meaningful: part === 'summary' ? c.in_s3 >= 0 : items.length > 0 || c.in_s3 === 0,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[images-in-s3] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'images_in_s3_v1', error: 'перепись не выполнена', sqlstate: code },
      { status: 503 },
    );
  }
}
