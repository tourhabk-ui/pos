/**
 * Занятость объекта жилья словами хозяина — запись и чтение (busy-dates —
 * чистая часть). Строки accommodation_availability с room_id IS NULL (721):
 * is_blocked = TRUE — ночь закрыта для гостей сайта.
 *
 * Право: объект обязан принадлежать карточке привязанного чата
 * (accommodations.partner_id) — тот же скоуп, что у ответа на заявку.
 * Чтение гостем (карточка, поиск по датам, заявка) — objectBusyNightsSql:
 * одно место, чтобы «занято» на карточке и в выдаче сходилось.
 */
import { pool } from '@/lib/db-pool';
import {
  BUSY_HORIZON_DAYS, BUSY_TEXT, busyConfirmText, busyManyObjectsText, busyObjectUnknownText, busyRejectText,
  parseBusyPhrase, type BusyAction, type BusyObjectView,
} from '@/lib/stay/busy-dates';

import { cabinetPayload } from '@/lib/chat-cabinet/payload';

interface Db { query: typeof pool.query }

/** Ответ на фразу хозяина: текст и, для «Понял так», кнопки «Записать» / «Не то». */
export interface BusyReply {
  text: string;
  buttons?: Array<Array<{ text: string; payload: string; intent?: 'positive' | 'negative' }>>;
}

export interface OwnerObject { id: string; name: string }

/**
 * Ночи объекта, закрытые хозяином, в окне [start, endExclusive). `acc`,
 * `start`, `endExclusive` — SQL-выражения с приведением ($1::uuid, $2::date).
 */
export function objectBusyNightsSql(acc: string, start: string, endExclusive: string): string {
  return `SELECT av.date::text AS night
            FROM accommodation_availability av
           WHERE av.accommodation_id = ${acc} AND av.room_id IS NULL AND av.is_blocked = TRUE
             AND av.date >= ${start} AND av.date < ${endExclusive}`;
}

/** Есть ли у объекта живые номера: тогда занятость считается от них (lib/stay/availability), не отсюда. */
export function hasActiveRoomsSql(acc: string): string {
  return `EXISTS (SELECT 1 FROM accommodation_rooms r WHERE r.accommodation_id = ${acc} AND r.is_active = TRUE)`;
}

export async function listOwnerObjects(partnerId: string, db: Db = pool): Promise<{ outcome: 'ok'; objects: OwnerObject[] } | { outcome: 'db_error' }> {
  try {
    const { rows } = await db.query<OwnerObject>(
      `SELECT id::text AS id, name FROM accommodations WHERE partner_id = $1::uuid AND is_active = TRUE ORDER BY name, id`,
      [partnerId],
    );
    return { outcome: 'ok', objects: rows };
  } catch (err) {
    console.error('[stay-busy] объекты хозяина не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет', err instanceof Error ? err.message : err);
    return { outcome: 'db_error' };
  }
}

export const BLOCK_SQL = `
  INSERT INTO accommodation_availability (accommodation_id, room_id, date, is_blocked, block_reason)
  SELECT $1::uuid, NULL::uuid, d::date, TRUE, $4::text
    FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d
  ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL
  DO UPDATE SET is_blocked = TRUE, block_reason = EXCLUDED.block_reason, updated_at = NOW()`;

export const RELEASE_SQL = `
  UPDATE accommodation_availability
     SET is_blocked = FALSE, block_reason = NULL, updated_at = NOW()
   WHERE accommodation_id = $1::uuid AND room_id IS NULL AND is_blocked = TRUE
     AND date >= $2::date AND date <= $3::date`;

export type SetBusyOutcome =
  | { outcome: 'saved'; name: string }
  | { outcome: 'not_yours' }
  | { outcome: 'db_error' };

/** Закрыть или открыть ночи объекта [from, to] включительно. Только свой объект. */
export async function setObjectBusy(opts: {
  partnerId: string;
  accommodationId: string;
  from: string;
  to: string;
  action: BusyAction;
  via: 'max' | 'telegram' | 'site';
  db?: Db;
}): Promise<SetBusyOutcome> {
  const db = opts.db ?? pool;
  try {
    const own = await db.query<{ name: string }>(
      `SELECT name FROM accommodations WHERE id = $1::uuid AND partner_id = $2::uuid`,
      [opts.accommodationId, opts.partnerId],
    );
    const name = own.rows[0]?.name;
    if (!name) return { outcome: 'not_yours' };
    if (opts.action === 'block') {
      await db.query(BLOCK_SQL, [opts.accommodationId, opts.from, opts.to, `хозяин: занято (${opts.via})`]);
    } else {
      await db.query(RELEASE_SQL, [opts.accommodationId, opts.from, opts.to]);
    }
    return { outcome: 'saved', name };
  } catch (err) {
    console.error('[stay-busy] занятость не записана, SQLSTATE', (err as { code?: string }).code ?? 'нет', err instanceof Error ? err.message : err);
    return { outcome: 'db_error' };
  }
}

/** Объекты хозяина и их занятые даты с `today` на BUSY_HORIZON_DAYS вперёд. null — не прочиталось. */
export async function loadOwnerBusy(partnerId: string, today: string, db: Db = pool): Promise<BusyObjectView[] | null> {
  try {
    const { rows } = await db.query<{ id: string; name: string; date: string | null }>(
      `SELECT a.id::text AS id, a.name, av.date::text AS date
         FROM accommodations a
         LEFT JOIN accommodation_availability av
           ON av.accommodation_id = a.id AND av.room_id IS NULL AND av.is_blocked = TRUE
          AND av.date >= $2::date AND av.date < $2::date + $3::int
        WHERE a.partner_id = $1::uuid AND a.is_active = TRUE
        ORDER BY a.name, a.id, av.date`,
      [partnerId, today, BUSY_HORIZON_DAYS],
    );
    const byId = new Map<string, BusyObjectView>();
    for (const r of rows) {
      const o = byId.get(r.id) ?? { id: r.id, name: r.name, dates: [] };
      if (r.date) o.dates.push(r.date);
      byId.set(r.id, o);
    }
    return [...byId.values()];
  } catch (err) {
    console.error('[stay-busy] занятость не прочитана, SQLSTATE', (err as { code?: string }).code ?? 'нет', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Объект по словам хозяина: подстрока названия без регистра. */
export function pickObjectByWords(objects: readonly OwnerObject[], words: string): OwnerObject | 'ambiguous' | null {
  const w = words.toLowerCase().replace(/ё/g, 'е').replace(/[«»"']/g, '').trim();
  if (!w) return null;
  const hits = objects.filter((o) => o.name.toLowerCase().replace(/ё/g, 'е').includes(w));
  if (hits.length === 1) return hits[0]!;
  return hits.length > 1 ? 'ambiguous' : null;
}

/**
 * Фраза хозяина в чате: «занято с 5 по 9 ноября» / «свободно …». null — не
 * хозяин жилья или не про занятость: помощник отвечает как раньше. Модель
 * фразу не видит: даты записываются из слов хозяина, а не из догадки модели.
 */
export async function handleStayBusyPhrase(opts: {
  partnerId: string;
  category: string;
  text: string;
  today: string;
  via: 'max' | 'telegram';
  db?: Db;
}): Promise<BusyReply | null> {
  if (opts.category !== 'stay') return null;
  const parsed = parseBusyPhrase(opts.text, opts.today);
  if (!parsed.ok) return parsed.reason === 'not_busy' ? null : { text: busyRejectText(parsed.reason) };
  const { command } = parsed;

  const listed = await listOwnerObjects(opts.partnerId, opts.db);
  if (listed.outcome === 'db_error') return { text: BUSY_TEXT.saveFailed };
  if (listed.objects.length === 0) return { text: BUSY_TEXT.noObjects };
  let target: OwnerObject;
  if (command.objectWords) {
    const picked = pickObjectByWords(listed.objects, command.objectWords);
    if (picked === null) {
      // Единственный объект — слова перед датами не название, а речь («занято у нас с …»).
      if (listed.objects.length === 1) target = listed.objects[0]!;
      else return { text: busyObjectUnknownText(command.objectWords, listed.objects.map((o) => o.name)) };
    } else if (picked === 'ambiguous') {
      return { text: busyManyObjectsText(listed.objects.map((o) => o.name), command.action) };
    } else {
      target = picked;
    }
  } else if (listed.objects.length === 1) {
    target = listed.objects[0]!;
  } else {
    return { text: busyManyObjectsText(listed.objects.map((o) => o.name), command.action) };
  }

  // Свободный текст пишется только после «Записать» (разбор 02.11: «Понял так»).
  // Кнопка несёт объект и даты; запись проверяет, что объект этого хозяина.
  const write = command.action === 'block'
    ? cabinetPayload.busyBlock(target.id, command.from, command.to)
    : cabinetPayload.busyRelease(target.id, command.from, command.to);
  return {
    text: busyConfirmText({ name: target.name, from: command.from, to: command.to, action: command.action }),
    buttons: [[
      { text: 'Записать', payload: write, intent: 'positive' },
      { text: 'Не то', payload: cabinetPayload.busyNotThat(), intent: 'negative' },
    ]],
  };
}
