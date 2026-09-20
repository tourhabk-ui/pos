/**
 * lib/map/places-readback.ts — сверка того, что легло в хранилище, с тем,
 * что заливали. Чистая функция: без сети и без S3, чтобы её можно было
 * прогнать на фикстурах.
 *
 * ── Зачем (17.09) ─────────────────────────────────────────────────────────
 *
 * Владелец прислал снимки полевой карты: «Смотровая у Авачинского вулкана»
 * и «Озеро Овальное» открываются на карте с городскими координатами — при
 * том что обе записи скрыты миграциями 950 и 947 ИМЕННО за эти координаты,
 * и прод на первую честно отвечает 404. Экспорт отбирает `is_visible`,
 * пакеты перезалиты 11.09 (123 файла, зелёный прогон), заголовок у
 * `.geojson` — `no-cache`, service worker чужой хост не трогает.
 *
 * То есть каждое звено, которое можно прочитать из репозитория, чисто, — а
 * человек в поле видит скрытое место. Единственное звено, которое из
 * репозитория не прочитать, — САМ ФАЙЛ В ХРАНИЛИЩЕ после заливки. Прогон
 * называл его залитым, потому что PutObject не бросил исключение, и больше
 * ничем: никто не читал файл обратно.
 *
 * «Залито» без чтения обратно — объявленный исход без источника (правило
 * 10.09). Теперь каждый пакет после заливки читается по публичному адресу и
 * сверяется байт в байт с тем, что заливали; расхождение — отказ прогона, а
 * не строка в логе.
 *
 * Отдельно — список «этого в пакете быть не должно»: id записей, скрытых
 * миграцией. Его передаёт запускающий (маркер прогона), и прогон отвечает
 * поимённо, в каких пакетах они всё ещё лежат. Это не второй фильтр поверх
 * экспорта — экспорт остаётся единственным местом, где решается видимость, —
 * а способ задать прогону вопрос владельца и получить ответ с раннера, где
 * хранилище достижимо.
 */

import { createHash } from 'node:crypto';

export interface ReadbackInput {
  region: string;
  /** Байты, которые отправили в PutObject. */
  uploaded: Buffer;
  /** Байты, прочитанные обратно по публичному адресу; null — прочитать не удалось. */
  fetched: Buffer | null;
  /** HTTP-статус чтения обратно; null — сети не было. */
  status: number | null;
  /** id записей, которых в пакете быть не должно (скрыты миграциями). */
  expectAbsent: readonly string[];
}

export type ReadbackVerdict =
  | { state: 'ok'; features: number; sha: string }
  /** Хранилище отдало не то, что заливали, — или не отдало вовсе. */
  | { state: 'mismatch'; reason: string }
  /** Байты совпали, но среди них — записи из списка «не должно быть». */
  | { state: 'stale-content'; features: number; presentAbsent: string[] };

/** Ответ на вопрос «есть ли скрытое в том, что СОБИРАЕМСЯ залить» (19.09). */
export type PreflightVerdict =
  /** Все пакеты читаются и скрытых записей в них нет. */
  | { state: 'clean'; packs: number }
  /** Экспорт отдал записи, которых быть не должно; `unreadable` — те, о ком судить нечем. */
  | { state: 'present'; hits: Array<{ region: string; ids: string[] }>; unreadable: string[] }
  /** Ни одного попадания, но часть пакетов не разобрать — это «не знаю», не «чисто». */
  | { state: 'unreadable'; regions: string[] };

/**
 * Спросить ДО заливки: нет ли в ответах экспорта записей из списка
 * «этого быть не должно».
 *
 * Появилось 19.09 по случаю: прогон 16 залил в хранилище 123 пакета, ТРИ из
 * них со скрытым дублем каньона, и только после этого прочитал их обратно и
 * покраснел. Проверка сработала верно и всё же опоздала — в поле дубль уже
 * уехал. Причина сочетания: маркер пушится следом за миграцией, а миграция
 * доезжает до прода со сборкой Timeweb минут через двадцать; шаг ожидания
 * при этом ждёт ВЕРСИЮ КОДА эндпоинта, которая от миграции не меняется.
 *
 * Ответы экспорта лежат в памяти целиком ещё до первой заливки (фаза 1 —
 * «слой либо целиком, либо никак»), поэтому вопрос ничего не стоит: те же
 * байты, тот же список, только раньше. Чтение обратно этим не отменяется —
 * оно отвечает за хранилище, а это за данные.
 *
 * Три исхода (§4.0): чисто · скрытое найдено · разобрать не смог. Третий не
 * равен первому: пакет, который не разобрался, — не «пакет без скрытых».
 */
export function verifyBeforeUpload(
  packs: ReadonlyArray<{ region: string; body: Buffer }>,
  expectAbsent: readonly string[],
): PreflightVerdict {
  const hits: Array<{ region: string; ids: string[] }> = [];
  const unreadable: string[] = [];

  for (const pack of packs) {
    const ids = featureIds(pack.body);
    if (ids === null) {
      unreadable.push(pack.region);
      continue;
    }
    const present = expectAbsent.filter((id) => ids.includes(id));
    if (present.length > 0) hits.push({ region: pack.region, ids: present });
  }

  if (hits.length > 0) return { state: 'present', hits, unreadable };
  if (unreadable.length > 0) return { state: 'unreadable', regions: unreadable };
  return { state: 'clean', packs: packs.length };
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * id всех фич коллекции. Разбор простой и не доверяет форме: не JSON или не
 * FeatureCollection — пустой список и отдельная причина у вызывающего.
 */
export function featureIds(body: Buffer): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;
  const ids: string[] = [];
  for (const f of features) {
    const id = (f as { properties?: { id?: unknown } })?.properties?.id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

export function verifyReadback(input: ReadbackInput): ReadbackVerdict {
  const { region, uploaded, fetched, status, expectAbsent } = input;

  if (fetched === null || status === null) {
    return { state: 'mismatch', reason: `${region}: файл не прочитался обратно (сети нет или отказ)` };
  }
  if (status !== 200) {
    return { state: 'mismatch', reason: `${region}: хранилище ответило HTTP ${status}` };
  }

  const up = sha256(uploaded);
  const down = sha256(fetched);
  if (up !== down) {
    return {
      state: 'mismatch',
      reason: `${region}: в хранилище лежит не то, что заливали (sha ${up.slice(0, 12)} против ${down.slice(0, 12)}, ${uploaded.length} против ${fetched.length} байт)`,
    };
  }

  const ids = featureIds(fetched);
  if (ids === null) {
    return { state: 'mismatch', reason: `${region}: прочитанное обратно — не FeatureCollection` };
  }

  const present = expectAbsent.filter((id) => ids.includes(id));
  if (present.length > 0) {
    return { state: 'stale-content', features: ids.length, presentAbsent: present };
  }
  return { state: 'ok', features: ids.length, sha: down };
}

/** Разобрать `PLACES_EXPECT_ABSENT`: id через запятую, пустое — пустой список. */
export function parseExpectAbsent(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
