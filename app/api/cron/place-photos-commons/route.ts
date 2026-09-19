/**
 * GET|POST /api/cron/place-photos-commons
 *
 * Пакетный сбор РЕАЛЬНЫХ фото мест с Wikimedia Commons — по координатам, со
 * свободной лицензией и с атрибуцией.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Задача владельца 19.09: «фото мест нужны». Законный путь к ним был написан
 * ДО этого дня и написан целиком: `lib/services/ingest/wikimedia-photos.ts`
 * ищет снимки рядом с координатой (geosearch по File-namespace), тянет автора
 * и лицензию из `extmetadata` и сам отбрасывает несвободные; карточка места
 * показывает кредит (`_PlaceDetailClient`, блок `photoAttribution`).
 *
 * Не хватало ровно одного — того, кто прошёл бы этим путём не по одному месту.
 * Единственный вызов `searchCommonsPhotos` жил в админском роуте
 * `/api/admin/places/[id]/wiki-candidates`: одно место за раз, руками. То есть
 * механизм существовал, а работы не делал — тот же род дефекта, что переезд
 * снимков в S3, пролежавший десять дней без вызывающего (CLAUDE.md §4.1).
 *
 * ── Три предохранителя, и они не косметические ─────────────────────────────
 *
 * 1. НИКОГДА не переписываем показываемый снимок. У `ai_route_images` UNIQUE
 *    по `route_id` (миграция 107) — один снимок на место, и `ON CONFLICT DO
 *    UPDATE` затирает то, что лежит. Среди лежащего 81 фотография владельца
 *    (`real-photo`, авторство проставлено миграцией 978). Очередь берёт только
 *    места без показываемого снимка, и перед записью это проверяется ВТОРОЙ
 *    раз, в той же транзакции: очередь могла быть собрана минуту назад.
 *
 * 2. НИКОГДА не сохраняем кандидата без автора ИЛИ лицензии. Ровно из-за
 *    этого 22 снимка рода `wikimedia-commons` лежат скрытыми с 14.09:
 *    «подписать нечем — показывать нельзя». Сохранить безымянное значит
 *    завести ещё двадцать таких же.
 *
 * 3. Сухой прогон по умолчанию. `dry_run: false` — осознанный аргумент.
 *    В сухом прогоне не пишется НИЧЕГО, включая пометки «не нашли».
 *
 * ── Почему кладём ПРЕВЬЮ, а не оригинал ────────────────────────────────────
 *
 * У оригиналов Commons бывают десятки мегабайт, а уменьшать их нам нечем:
 * `sharp` импортируется тремя нашими роутами, но в `package.json` НЕ объявлен
 * — он лежит на диске транзитивно от `next` и `@huggingface/transformers`.
 * Строить новый крон на пакете, которого манифест не просил, нельзя. Поэтому
 * превью нужной ширины рендерит сам Commons (`iiurlwidth`), а мы кладём его
 * байты как есть. Тяжёлое сверх порога не кладём вовсе и говорим об этом
 * вслух — это третий исход, а не тихий пропуск.
 *
 * ── Снимок ложится в S3, а не в базу ───────────────────────────────────────
 *
 * Решение владельца 19.09: «фото должны быть в s3, там больше места, 100 ГБ».
 * Первая редакция этого роута клала байты в `image_data` и полагалась на
 * суточный `cron-images-to-s3.yml`, который их потом увозит. Так было БЫ
 * правильно по результату и неправильно по существу: §4.1 говорит прямо —
 * «байтам фотографии в PostgreSQL не место», а уборщик делает правку
 * писателей необязательной для правильности, но не отменяет её. База сегодня
 * 882 МБ, из них 441 МБ — снимки; складывать туда новые, чтобы через сутки
 * вывезти, значит занимать самое дорогое место самым дешёвым содержимым.
 *
 * Порядок записи взят у переезда и не переставляется: залить объект →
 * ПРОЧИТАТЬ его обратно и сверить размер → и только теперь писать строку.
 * Заливка, вернувшая успех, — ещё не доказательство: строка со ссылкой на
 * нечитаемый объект хуже отсутствия строки, потому что выглядит как снимок.
 *
 * S3 не настроен — не пишем вовсе и говорим об этом отдельным исходом.
 * Молчаливый откат «тогда положим в базу» вернул бы ровно то, что здесь
 * исправляется.
 *
 * ── «Не нашли» — это не «фото нет» ─────────────────────────────────────────
 *
 * Место, рядом с которым Commons не знает ни одного свободного снимка, —
 * отдельный исход. Он записывается пометкой в `agent_memory` со СРОКОМ
 * (Commons пополняется), и очередь такие места временно пропускает. Без
 * пометки каждый следующий прогон утыкался бы в те же первые N мест.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { shownPhotoSql } from '@/lib/images/origin';
import { searchCommonsPhotos, downloadPhotoBytes } from '@/lib/services/ingest/wikimedia-photos';
import { uploadToS3, deleteFromS3, extFor, isS3Configured } from '@/lib/storage/s3';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Ширина превью, которое просим у Commons. */
const THUMB_WIDTH = 1280;
/**
 * Радиус поиска вокруг места — решение владельца 19.09: «3 км».
 *
 * Выбор был между тремя километрами и десятью (потолок API). Десять дают
 * больше кандидатов и больше мусора: geosearch ищет снимки РЯДОМ С ТОЧКОЙ, и
 * за десять километров от вулкана попадает всё подряд. Три — строже, снимков
 * меньше, но они про это место.
 *
 * Число остаётся параметром запроса: решение задаёт умолчание, а не запрет.
 * Расширять радиус на конкретной партии можно, и тогда это видно в ответе.
 */
const DEFAULT_RADIUS_M = 3000;
/**
 * Тяжелее — не кладём. Порог перестал быть про место: в хранилище его 100 ГБ,
 * и превью 1280 px весит сотни килобайт. Он остался ловушкой на неожиданное —
 * превью, которое почему-то оказалось оригиналом, — потому что уменьшать нам
 * по-прежнему нечем (sharp не объявлен, см. шапку).
 */
const MAX_BYTES = 8 * 1024 * 1024;
/** Пауза между запросами к чужому API. */
const PAUSE_MS = 1200;
/** Сколько не возвращаться к месту, у которого кандидатов не нашлось. */
const NO_CANDIDATE_TTL_DAYS = 30;

const AGENT_ID = 'place-photos-commons';
const MEMORY_TYPE = 'no_candidate';

const Body = z.object({
  batch: z.number().int().positive().max(25).optional(),
  radius_m: z.number().int().min(200).max(10_000).optional(),
  /** Сухой прогон — по умолчанию ДА. Запись требует явного false. */
  dry_run: z.boolean().optional(),
});

/** Живое место: видимое и не слитое (тот же предикат, что у place-link-suggest). */
const LIVE_PLACE = `p.is_visible = true AND p.merged_into_id IS NULL`;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return timingSafeCompare(getCronSecret(request), secret);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Тип превью по его адресу; не вывелось — берём тип оригинала. */
export function thumbMime(thumbUrl: string, originalMime: string): string {
  const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(thumbUrl)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return originalMime;
}

// ── Перепись ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      live_total: string;
      with_shown: string;
      with_hidden_only: string;
      without_any: string;
      no_ark: string;
    }>(
      `SELECT
         COUNT(*)::text AS live_total,
         COUNT(*) FILTER (WHERE img.route_id IS NOT NULL AND ${shownPhotoSql('img.model')})::text AS with_shown,
         COUNT(*) FILTER (WHERE img.route_id IS NOT NULL AND NOT ${shownPhotoSql('img.model')})::text AS with_hidden_only,
         COUNT(*) FILTER (WHERE img.route_id IS NULL)::text AS without_any,
         COUNT(*) FILTER (WHERE p.ark_id IS NULL)::text AS no_ark
       FROM places p
       LEFT JOIN ai_route_images img ON img.route_id = p.ark_id
       WHERE ${LIVE_PLACE}`,
    );

    // Разбивка скрытого — по роду: она называет, ЧЕМ занято место.
    const byModel = await pool.query<{ model: string | null; n: string; credited: string }>(
      `SELECT img.model,
              COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE img.author IS NOT NULL AND img.license IS NOT NULL)::text AS credited
         FROM places p
         JOIN ai_route_images img ON img.route_id = p.ark_id
        WHERE ${LIVE_PLACE} AND NOT ${shownPhotoSql('img.model')}
        GROUP BY img.model
        ORDER BY COUNT(*) DESC`,
    );

    // Судьба тех 22: есть ли ссылка на файл Commons, по которой автора можно
    // добрать уже написанным кодом. Нет ссылки — место просто попадёт в общую
    // очередь и получит новый снимок с атрибуцией.
    const commonsLegacy = await pool.query<{ total: string; with_source: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE source_url IS NOT NULL AND source_url <> '')::text AS with_source
         FROM ai_route_images WHERE model = 'wikimedia-commons'`,
    );

    const marks = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agent_memory
        WHERE agent_id = $1 AND memory_type = $2
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [AGENT_ID, MEMORY_TYPE],
    );

    const r = rows[0];
    return NextResponse.json({
      ok: true,
      live_places: Number(r?.live_total ?? 0),
      with_shown_photo: Number(r?.with_shown ?? 0),
      photo_hidden_only: Number(r?.with_hidden_only ?? 0),
      without_any_photo: Number(r?.without_any ?? 0),
      // Место без ark_id связать со снимком нечем — это отдельное состояние,
      // а не «нет фото».
      without_ark_id: Number(r?.no_ark ?? 0),
      hidden_by_model: byModel.rows.map((m) => ({
        model: m.model,
        count: Number(m.n),
        with_attribution: Number(m.credited),
      })),
      legacy_wikimedia_commons: {
        total: Number(commonsLegacy.rows[0]?.total ?? 0),
        with_source_url: Number(commonsLegacy.rows[0]?.with_source ?? 0),
      },
      marked_no_candidate: Number(marks.rows[0]?.n ?? 0),
    });
  } catch (err) {
    // §4.0: «не смог» не выдаётся за «нарушений нет».
    console.error('[place-photos-commons] перепись не выполнена:', err);
    return NextResponse.json({ ok: false, error: 'Перепись не выполнена' }, { status: 500 });
  }
}

// ── Сбор ────────────────────────────────────────────────────────────────────

interface PlaceRow {
  id: string;
  ark_id: string;
  name: string;
  lat: string;
  lng: string;
}

type Outcome =
  | { place: string; name: string; status: 'saved'; title: string; author: string; license: string; size_kb: number; distance_m: number | null }
  | { place: string; name: string; status: 'would_save'; title: string; author: string; license: string; distance_m: number | null }
  | { place: string; name: string; status: 'no_candidate' }
  | { place: string; name: string; status: 'no_attribution'; checked: number }
  | { place: string; name: string; status: 'too_heavy'; size_kb: number }
  | { place: string; name: string; status: 'occupied' }
  | { place: string; name: string; status: 'no_storage' }
  | { place: string; name: string; status: 'failed'; reason: string };

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Неверные параметры запроса' }, { status: 400 });
  }
  const batch = parsed.data.batch ?? 10;
  const radiusM = parsed.data.radius_m ?? DEFAULT_RADIUS_M;
  // Умолчание — сухой прогон. Запись только по явному false.
  const dryRun = parsed.data.dry_run !== false;

  let queue: PlaceRow[];
  try {
    const { rows } = await pool.query<PlaceRow>(
      `SELECT p.id::text AS id, p.ark_id::text AS ark_id, p.name,
              p.lat::text AS lat, p.lng::text AS lng
         FROM places p
         LEFT JOIN ai_route_images img ON img.route_id = p.ark_id
        WHERE ${LIVE_PLACE}
          AND p.ark_id IS NOT NULL
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND (img.route_id IS NULL OR NOT ${shownPhotoSql('img.model')})
          AND NOT EXISTS (
            SELECT 1 FROM agent_memory m
             WHERE m.agent_id = $1 AND m.memory_type = $2
               AND m.key = p.ark_id::text
               AND (m.expires_at IS NULL OR m.expires_at > NOW())
          )
        ORDER BY p.name
        LIMIT $3`,
      [AGENT_ID, MEMORY_TYPE, batch],
    );
    queue = rows;
  } catch (err) {
    console.error('[place-photos-commons] очередь не прочитана:', err);
    return NextResponse.json({ ok: false, error: 'Очередь не прочитана' }, { status: 500 });
  }

  // Хранилище не настроено — класть некуда, и молчаливый откат «тогда в
  // базу» вернул бы то, ради чего этот роут переписан. Сухому прогону
  // хранилище не нужно: он ничего не кладёт.
  if (!dryRun && !isS3Configured) {
    console.error('[place-photos-commons] S3 не настроен: заливать некуда');
    return NextResponse.json({
      ok: false, dry_run: false,
      error: 'S3 не настроен — снимки класть некуда',
    }, { status: 503 });
  }

  const results: Outcome[] = [];

  for (let i = 0; i < queue.length; i++) {
    const place = queue[i];
    if (i > 0) await sleep(PAUSE_MS);

    let candidates;
    try {
      candidates = await searchCommonsPhotos(Number(place.lat), Number(place.lng), {
        radiusM,
        limit: 5,
        thumbWidth: THUMB_WIDTH,
      });
    } catch (err) {
      // Отказ чужого сервиса — не «фото нет». Пометку НЕ ставим.
      const reason = err instanceof Error ? err.message.slice(0, 120) : 'ошибка';
      console.error('[place-photos-commons] Commons не ответил:', place.name, reason);
      results.push({ place: place.id, name: place.name, status: 'failed', reason });
      continue;
    }

    if (candidates.length === 0) {
      results.push({ place: place.id, name: place.name, status: 'no_candidate' });
      if (!dryRun) await markNoCandidate(place.ark_id);
      continue;
    }

    // Подписать нечем — показывать нельзя. Берём ПЕРВОГО с полной атрибуцией,
    // а не первого вообще: ближайший снимок бывает безымянным.
    const pick = candidates.find((c) => c.author.trim() !== '' && c.license.trim() !== '');
    if (!pick) {
      results.push({
        place: place.id, name: place.name,
        status: 'no_attribution', checked: candidates.length,
      });
      if (!dryRun) await markNoCandidate(place.ark_id);
      continue;
    }

    if (dryRun) {
      results.push({
        place: place.id, name: place.name, status: 'would_save',
        title: pick.title, author: pick.author, license: pick.license,
        distance_m: pick.distanceM,
      });
      continue;
    }

    try {
      const bytes = await downloadPhotoBytes(pick.thumbUrl);
      if (bytes.length > MAX_BYTES) {
        results.push({
          place: place.id, name: place.name, status: 'too_heavy',
          size_kb: Math.round(bytes.length / 1024),
        });
        continue;
      }

      const saved = await saveToStorageIfStillFree(place, pick, bytes);
      results.push(
        saved
          ? {
              place: place.id, name: place.name, status: 'saved',
              title: pick.title, author: pick.author, license: pick.license,
              size_kb: Math.round(bytes.length / 1024), distance_m: pick.distanceM,
            }
          : { place: place.id, name: place.name, status: 'occupied' },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 120) : 'ошибка';
      console.error('[place-photos-commons] снимок не сохранён:', place.name, reason);
      results.push({ place: place.id, name: place.name, status: 'failed', reason });
    }
  }

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    radius_m: radiusM,
    // Пустая очередь при непустом реестре — не успех: сказать об этом обязан
    // сам ответ, иначе «разобрано 0 из N» читается как «всё готово» (§4.0).
    queue_size: queue.length,
    exhausted: queue.length === 0,
    tally,
    results,
  });
}

/** Пометка «рядом свободных снимков не нашлось» — со сроком, а не навсегда. */
async function markNoCandidate(arkId: string): Promise<void> {
  try {
    await pool.query(
      // Срок — параметром через make_interval, а не склейкой строки: интервал,
      // собранный конкатенацией, запрещён сторожем sql-interval-not-concatenated.
      `INSERT INTO agent_memory (agent_id, memory_type, key, value, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW() + make_interval(days => $5::int))
       ON CONFLICT (agent_id, memory_type, key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [AGENT_ID, MEMORY_TYPE, arkId, JSON.stringify({ at: new Date().toISOString() }), NO_CANDIDATE_TTL_DAYS],
    );
  } catch (err) {
    // Пометка не легла — прогон от этого не портится, но молчать нельзя:
    // без неё следующая партия снова упрётся в те же места.
    console.error('[place-photos-commons] пометка не записана:', arkId, err);
  }
}

/**
 * Снимок в ХРАНИЛИЩЕ, ссылка в строку — и только если место всё ещё свободно.
 *
 * Порядок не переставляется (взят у `images-to-s3`, §4.1):
 *   1. залить объект в S3;
 *   2. ПРОЧИТАТЬ его обратно и сверить размер;
 *   3. и только теперь писать строку, где `image_data` пуст.
 *
 * Заливка, вернувшая успех, доказательством не является. Строка со ссылкой на
 * нечитаемый объект хуже отсутствия строки: карточка покажет битую картинку, а
 * перепись посчитает место обеспеченным.
 *
 * Занятость проверяется предикатом ВНУТРИ запроса, а не отдельным вопросом до
 * него: между сбором очереди и записью проходят секунды сетевых вызовов, и за
 * это время владелец мог залить своё фото. Условие у `DO UPDATE` относится к
 * УЖЕ ЛЕЖАЩЕЙ строке; пустой род назван отдельно, потому что сравнение NULL со
 * списком даёт NULL, а не «ложь», и без этой ветки место с безымянным снимком
 * не обновилось бы никогда, вечно возвращаясь в очередь как «занято».
 *
 * Место оказалось занято — залитый объект удаляется тут же: сирота, о которой
 * никто не знает, хуже занятого места. Прежний объект замещённой строки тоже
 * удаляется, и это делается ПОСЛЕ удачной записи — не раньше, иначе неудачная
 * запись оставила бы карточку вовсе без снимка.
 *
 * Возвращает false, если место занято, — это исход, а не ошибка.
 */
async function saveToStorageIfStillFree(
  place: PlaceRow,
  pick: { title: string; thumbUrl: string; thumbWidth: number; thumbHeight: number; mime: string; author: string; license: string; licenseUrl: string; descriptionUrl: string },
  bytes: Buffer,
): Promise<boolean> {
  const mime = thumbMime(pick.thumbUrl, pick.mime);
  // Новый ключ на каждую заливку: под постоянным ключом замена снимка меняла
  // бы содержимое по неизменному адресу, а он роздан с `immutable` на год.
  const key = `places/${place.ark_id}/commons-${randomUUID()}.${extFor(mime)}`;

  const uploaded = await uploadToS3(key, bytes, mime);

  const check = await fetch(uploaded.url, { cache: 'no-store' });
  if (!check.ok) {
    await dropObject(key);
    throw new Error(`объект не читается после заливки: HTTP ${check.status}`);
  }
  const readBack = Buffer.from(await check.arrayBuffer());
  if (readBack.length !== bytes.length) {
    await dropObject(key);
    throw new Error(`размер не сошёлся: залито ${bytes.length}, прочитано ${readBack.length}`);
  }

  // Что лежало раньше — чтобы не оставить объект, на который больше нет ссылки.
  const prev = await pool.query<{ s3_key: string | null }>(
    `SELECT s3_key FROM ai_route_images WHERE route_id = $1`,
    [place.ark_id],
  );
  const prevKey = prev.rows[0]?.s3_key ?? null;

  const { rowCount } = await pool.query(
    `INSERT INTO ai_route_images
       (route_id, image_data, mime_type, prompt, model, width, height,
        source_url, author, license, license_url, s3_key, s3_url)
     VALUES ($1, NULL, $2, $3, 'wikimedia', $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (route_id) DO UPDATE
       SET image_data  = NULL,
           mime_type   = EXCLUDED.mime_type,
           prompt      = EXCLUDED.prompt,
           model       = EXCLUDED.model,
           width       = EXCLUDED.width,
           height      = EXCLUDED.height,
           source_url  = EXCLUDED.source_url,
           author      = EXCLUDED.author,
           license     = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           s3_key      = EXCLUDED.s3_key,
           s3_url      = EXCLUDED.s3_url,
           created_at  = now()
       WHERE ai_route_images.model IS NULL
          OR NOT (${shownPhotoSql('ai_route_images.model')})`,
    [
      place.ark_id,
      mime,
      `Wikimedia Commons: ${pick.title}`,
      pick.thumbWidth,
      pick.thumbHeight,
      pick.descriptionUrl || null,
      pick.author || null,
      pick.license || null,
      pick.licenseUrl || null,
      uploaded.key,
      uploaded.url,
    ],
  );

  if ((rowCount ?? 0) === 0) {
    // Место заняли, пока мы ходили в сеть. Свой объект забираем обратно.
    await dropObject(key);
    return false;
  }
  if (prevKey && prevKey !== uploaded.key) await dropObject(prevKey);
  return true;
}

/** Удаление объекта — «не смог» пишется в лог, но прогон не роняет. */
async function dropObject(key: string): Promise<void> {
  try {
    await deleteFromS3(key);
  } catch (err) {
    console.error('[place-photos-commons] объект не удалён из хранилища:', key, err);
  }
}
