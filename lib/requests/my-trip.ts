/**
 * lib/requests/my-trip.ts
 *
 * «Моя поездка» в чате Кузьмича (#2970, владелец 10.11): заявки, привязанные
 * к ЭТОМУ чату MAX или Telegram, их статус словами и обстановка на даты.
 *
 * Откуда заявки — только связь «чат ↔ ключ заявки» (миграция 1416,
 * lib/requests/chat-links): заявка создана здесь, открыта ссылкой переписки,
 * погашен код между каналами, вставлена ссылка статуса. По телефону и имени
 * не ищем. Статус читается по номерам ключей без сырого ключа
 * (REQUEST_STATUS_BY_KEY_IDS_SQL), без отметки прочтения: это не обращение
 * агента, а просьба самого человека.
 *
 * ПД в ответе нет по построению: название тура или объекта, дата и статус
 * словами — тот же набор, что `get_request_status`. Годится и для Telegram.
 *
 * Обстановка — тем же судьёй, что напоминание за двое суток
 * (lib/trips/situation-store: прогноз по точке тура, официальные
 * предупреждения по зоне, оценка зоны). Прогноз берётся на 5 дней, поэтому
 * обстановка — только для поездок в эти 5 дней; дальше — «покажу ближе к
 * дате», а не выдуманное «спокойно».
 */
import { pool } from '@/lib/db-pool';
import { chatLinkedKeyIds, type LinkChannel } from '@/lib/requests/chat-links';
import { REQUEST_STATUS_BY_KEY_IDS_SQL, buildRequestView, type StatusRow } from '@/lib/mcp/request-status';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { situationLine, type Situation } from '@/lib/trips/situation';
import type { DepartingTour, SituationSources } from '@/lib/trips/situation-store';
import { logText } from '@/lib/log/log-text';

/** Сколько дней вперёд показывается обстановка: столько дней даёт прогноз (liveSources). */
export const MY_TRIP_SITUATION_DAYS = 5;
/** Сколько заявок показываем: свежие первыми. */
export const MY_TRIP_MAX_ITEMS = 5;

export { MY_TRIP_BUTTON, isMyTripAsk } from '@/lib/requests/my-trip-ask';

/** Что о поездке по заявке. */
export type TripSituationNote =
  | { kind: 'line'; date: string; text: string }
  | { kind: 'later' }
  | { kind: 'unchecked' }
  | { kind: 'none' };

export interface MyTripItem {
  /** Тур или объект жилья; null — не записано. */
  what: string | null;
  date: string | null;
  /** Статус словами для человека (тот же, что у страницы заявки). */
  human: string;
  situation: TripSituationNote;
}

export type MyTrip =
  | { outcome: 'none' }
  | { outcome: 'failed' }
  | { outcome: 'ok'; items: MyTripItem[] };

/** Номер тура заявки: у лида — `source_data.tour_id` (записал роут MCP), у запроса мест — колонка. */
export const REQUEST_TOUR_IDS_SQL = `
  SELECT l.id::text AS id, (l.source_data->>'tour_id')::bigint AS tour_id
    FROM leads l
   WHERE l.id = ANY($1::uuid[]) AND l.source_data->>'tour_id' ~ '^[0-9]{1,18}$'
  UNION ALL
  SELECT r.id::text, r.tour_id::bigint
    FROM tour_seat_requests r
   WHERE r.id = ANY($2::uuid[]) AND r.tour_id IS NOT NULL`;

/** Тур для судьи обстановки: точка и зона — как у напоминания (DEPARTING_TOURS_SQL). */
export const TRIP_TOURS_SQL = `
  SELECT ot.id::int AS tour_id, ot.title, ot.operator_id::text AS operator_id,
         ot.activity_type, ot.location_type,
         COALESCE(kr.zone, p.zone) AS zone,
         COALESCE(ot.latitude, p.lat, kr.lat)::float8 AS lat,
         COALESCE(ot.longitude, p.lng, kr.lng)::float8 AS lng
    FROM operator_tours ot
    LEFT JOIN places p ON p.id = ot.main_place_id
    LEFT JOIN kamchatka_routes kr ON kr.id = ot.route_id
   WHERE ot.id = ANY($1::bigint[])`;

const sqlState = (err: unknown) => {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? `SQLSTATE=${logText(c, 10)}` : 'нет SQLSTATE';
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isHandoffKey = (r: StatusRow): boolean => typeof r.tool_name === 'string' && r.tool_name.startsWith('handoff:');

/** Цель заявки — для склейки: одна заявка могла прийти в чат двумя ключами (создана здесь и открыта ссылкой). */
function targetOf(r: StatusRow): string | null {
  return r.lead_id ? `l:${r.lead_id}` : r.seat_request_id ? `s:${r.seat_request_id}` : r.stay_request_id ? `a:${r.stay_request_id}` : null;
}

/**
 * Заявки чата и обстановка. `src` — источники судьи обстановки; без них
 * (нет прогноза, нет ленты) обстановка — «не проверил», не «спокойно».
 */
export async function loadMyTrip(
  channel: LinkChannel, chatId: string | number,
  opts: { now?: number; sources?: () => Promise<SituationSources> } = {},
): Promise<MyTrip> {
  const ids = await chatLinkedKeyIds(channel, chatId);
  if (ids === 'failed') return { outcome: 'failed' };
  if (ids.length === 0) return { outcome: 'none' };

  let rows: StatusRow[];
  try {
    rows = (await pool.query<StatusRow>(REQUEST_STATUS_BY_KEY_IDS_SQL, [ids])).rows;
  } catch (err) {
    console.error('[my-trip] статусы заявок не прочитались:', sqlState(err));
    return { outcome: 'failed' };
  }
  // Порядок — как у связей (свежие первыми); одна заявка — одна строка.
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.key_id ?? '') ?? 0) - (order.get(b.key_id ?? '') ?? 0));
  // Ключ, выданный по коду между каналами (`handoff:…`), даты и тура заявки
  // не знает (статус их отдаёт ключу исходного инструмента) — из двух ключей
  // одной заявки берётся ключ инструмента, место в списке — первое.
  const byTarget = new Map<string, StatusRow>();
  for (const r of rows) {
    const t = targetOf(r);
    if (!t) continue;
    const prev = byTarget.get(t);
    if (!prev || (isHandoffKey(prev) && !isHandoffKey(r))) byTarget.set(t, r);
  }
  const unique = [...byTarget.values()].slice(0, MY_TRIP_MAX_ITEMS);
  if (unique.length === 0) return { outcome: 'none' };

  const now = opts.now ?? Date.now();
  const today = kamchatkaToday(now);
  const horizon = addDays(today, MY_TRIP_SITUATION_DAYS - 1);
  // Дата поездки: у брони — действующая (оператор мог перенести), у заявки
  // без брони — та, что просили. Обе из базы, не из текста.
  const views = unique.map((r) => {
    const view = buildRequestView(r, now);
    return { row: r, view, date: view.date ?? view.requested_date };
  });

  // Номера туров — только тем, у кого обстановку есть смысл считать.
  const leadIds = unique.map((r) => r.lead_id).filter((x): x is string => Boolean(x));
  const seatIds = unique.map((r) => r.seat_request_id).filter((x): x is string => Boolean(x));
  let tourOf: Map<string, number> | 'failed' = new Map();
  if (leadIds.length || seatIds.length) {
    try {
      const { rows: t } = await pool.query<{ id: string; tour_id: string | number }>(REQUEST_TOUR_IDS_SQL, [leadIds, seatIds]);
      tourOf = new Map(t.map((x) => [x.id, Number(x.tour_id)]));
    } catch (err) {
      console.error('[my-trip] туры заявок не прочитались:', sqlState(err));
      tourOf = 'failed';
    }
  }

  const soon = views.filter(({ row, date }) => {
    const id = row.lead_id ?? row.seat_request_id;
    return date !== null && date >= today && date <= horizon
      && id !== null && tourOf !== 'failed' && tourOf.has(id);
  });
  const situations = new Map<string, TripSituationNote>();
  if (soon.length && tourOf !== 'failed') {
    const tourIds = [...new Set(soon.map(({ row }) => (tourOf as Map<string, number>).get((row.lead_id ?? row.seat_request_id)!)!))];
    try {
      const { rows: tours } = await pool.query<{
        tour_id: number; title: string; operator_id: string; activity_type: string | null;
        location_type: string | null; zone: string | null; lat: number | null; lng: number | null;
      }>(TRIP_TOURS_SQL, [tourIds]);
      const byId = new Map(tours.map((t) => [Number(t.tour_id), t]));
      const src = opts.sources ? await opts.sources() : await defaultSources();
      for (const { row, date } of soon) {
        const target = targetOf(row)!;
        const t = byId.get((tourOf as Map<string, number>).get((row.lead_id ?? row.seat_request_id)!)!);
        if (!t || !src) { situations.set(target, { kind: 'unchecked' }); continue; }
        const tour: DepartingTour = {
          tourId: Number(t.tour_id), date: date!, title: t.title, operatorId: t.operator_id,
          activityType: t.activity_type, locationType: t.location_type, zone: t.zone,
          lat: t.lat === null ? null : Number(t.lat), lng: t.lng === null ? null : Number(t.lng),
          travellers: 1,
        };
        try {
          const { situationFor } = await import('@/lib/trips/situation-store');
          const s: Situation = await situationFor(tour, src);
          situations.set(target, { kind: 'line', date: date!, text: situationLine(s) });
        } catch (err) {
          console.error('[my-trip] обстановка не посчиталась:', logText(err instanceof Error ? err.message : err, 160));
          situations.set(target, { kind: 'unchecked' });
        }
      }
    } catch (err) {
      console.error('[my-trip] туры для обстановки не прочитались:', sqlState(err));
      for (const { row } of soon) situations.set(targetOf(row)!, { kind: 'unchecked' });
    }
  }

  const items: MyTripItem[] = views.map(({ row, view, date }) => {
    const target = targetOf(row)!;
    const id = row.lead_id ?? row.seat_request_id;
    const hasTour = id !== null && tourOf !== 'failed' && tourOf.has(id);
    let situation: TripSituationNote = { kind: 'none' };
    if (situations.has(target)) situation = situations.get(target)!;
    else if (date !== null && date > horizon && (hasTour || tourOf === 'failed')) situation = { kind: 'later' };
    else if (date !== null && date >= today && tourOf === 'failed') situation = { kind: 'unchecked' };
    return { what: view.tour ?? view.accommodation, date, human: view.human, situation };
  });
  return { outcome: 'ok', items };
}

async function defaultSources(): Promise<SituationSources | null> {
  try {
    const { liveSources } = await import('@/lib/trips/situation-store');
    return liveSources();
  } catch (err) {
    console.error('[my-trip] источники обстановки не поднялись:', logText(err instanceof Error ? err.message : err, 160));
    return null;
  }
}

function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export const MY_TRIP_NONE_TEXT =
  'В этом чате заявок пока нет. Если заявку оставляли на сайте или в другом мессенджере — пришлите сюда код заявки '
  + '(вида ABCD-EFGH, он на странице статуса) или саму ссылку статуса: заявка появится здесь.';

export const MY_TRIP_FAILED_TEXT =
  'Список заявок сейчас не прочитался — это сбой на нашей стороне, а не «заявок нет». Повторите через минуту.';

/**
 * Канал без связи «чат ↔ заявка» (WhatsApp, Meta): списка здесь нет вовсе.
 * Его id чата — не id чата MAX или Telegram, и читать по нему нечего.
 */
export const MY_TRIP_NO_CHANNEL_TEXT =
  'В этом канале список заявок не показываю. Статус заявки — по ссылке из сообщения о ней; '
  + 'список «Моя поездка» есть в чате Кузьмича в MAX и Telegram.';

/** Ответ человеку. Без ПД: название, дата, статус словами, обстановка. */
export function myTripText(trip: MyTrip): string {
  if (trip.outcome === 'none') return MY_TRIP_NONE_TEXT;
  if (trip.outcome === 'failed') return MY_TRIP_FAILED_TEXT;
  const blocks = trip.items.map((it, i) => {
    const head = `${i + 1}. ${it.what ?? 'Заявка'}${it.date ? `, ${ruDate(it.date)}` : ''}`;
    const lines = [head, it.human];
    const s = it.situation;
    if (s.kind === 'line') lines.push(`Обстановка на ${ruDate(s.date)}: ${s.text}`);
    else if (s.kind === 'later') lines.push(`Обстановку на дату поездки покажу ближе к ней — за ${MY_TRIP_SITUATION_DAYS} дней.`);
    else if (s.kind === 'unchecked') lines.push('Обстановку на дату поездки сейчас не проверил — это не значит, что всё спокойно.');
    return lines.filter(Boolean).join('\n');
  });
  return [
    trip.items.length === 1 ? 'Ваша заявка в этом чате:' : 'Ваши заявки в этом чате:',
    ...blocks,
    'Решение о выезде принимает оператор. Экстренный вызов — 112.',
  ].join('\n\n');
}

/** Всё вместе: прочитать и сказать. */
export async function myTripReply(channel: LinkChannel, chatId: string | number): Promise<string> {
  return myTripText(await loadMyTrip(channel, chatId));
}
