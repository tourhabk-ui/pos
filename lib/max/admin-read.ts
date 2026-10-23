/**
 * Что администратор видит в MAX — фаза 1, только чтение (слово владельца
 * 23.10: «2б» — смотреть всё, действия с кнопкой — следующим шагом).
 *
 * Ответы детерминированные, без модели: правило отбора — то же, что у
 * сторожей и витрины, а не своё.
 *  - даты    — туры витрины (publicTourSql) и свободные места на 30 дней тем
 *              же расчётом, что гейт брони (fetchAvailabilityForTour);
 *  - брони   — новые, ждут подтверждения оператора; пороги — как у Watchdog
 *              (сутки — «без подтверждения», двое суток — «оператор молчит»);
 *  - заявки  — без ответа человека (UNATTENDED_LEAD_STATUSES), без
 *              псевдолидов чата виджета; порог два часа — как у Watchdog;
 *  - сводка  — readDaySummary, те же числа, что полоса обзора админки;
 *  - здоровье — последний прогон Watchdog: исход, что не проверено, сколько
 *              тревог и каких видов (сами тревоги могут нести координаты SOS —
 *              их здесь нет).
 *
 * ПД туристов (имя, телефон) есть только в бронях и заявках. Эти тексты
 * собираются здесь, отдаются вызывающему с пометкой `pd: true` и уходят
 * ТОЛЬКО в личный чат администратора в MAX (sendPdAlert с явным адресом, без
 * отката на общий чат) — правило владельца 23.08 «ПД только в MAX». В модель
 * и в историю переписки они не попадают.
 *
 * Каждый читатель — три исхода (§4.0): «есть», «нет» словами и «не
 * прочиталось» с SQLSTATE в логе. Пустота при отказе базы — не «ничего нет».
 */

import { pool } from '@/lib/db-pool';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { UNATTENDED_LEAD_STATUSES } from '@/lib/types/statuses';
import { WIDGET_CHAT_PSEUDO_LEAD_SQL } from '@/lib/leads/widget-chat-pseudo';
import { readDaySummary } from '@/lib/analytics/day-summary';
import type { Metric } from '@/lib/analytics/day-summary-types';
import { escapeHtml } from '@/lib/text/escape-html';

/** Предел одного сообщения MAX — с запасом под «и ещё N». */
export const ADMIN_MAX_MESSAGE_CHARS = 3800;
export const ADMIN_DATES_DAYS = 30;
const LIST_LIMIT = 20;
const TOURS_LIMIT = 60;

export type AdminCommand = 'help' | 'dates' | 'bookings' | 'leads' | 'summary' | 'health';

/** Ответ администратору: текст в HTML MAX и есть ли в нём ПД туристов. */
export interface AdminReply { text: string; pd: boolean }

/**
 * Команда из текста администратора. null — не понял: отвечает подсказка, а
 * не модель (свободный разговор — следующим шагом, вместе с действиями).
 */
export function adminCommandOf(text: string): AdminCommand | null {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е');
  if (/^\/(start|help)\b/.test(t) || /^(помощь|команды|меню|что умеешь)/.test(t)) return 'help';
  if (/дат|расписан|свободн.*мест/.test(t)) return 'dates';
  if (/брон/.test(t)) return 'bookings';
  if (/заявк|лид/.test(t)) return 'leads';
  if (/сводк|итог|за сутки|посетител/.test(t)) return 'summary';
  if (/здоров|состояни|сбо|сторож|watchdog/.test(t)) return 'health';
  return null;
}

export const ADMIN_HELP_TEXT = [
  'Что спросить (словами или одним словом):',
  '• <b>даты</b> — открытые даты всех туров витрины на 30 дней, со свободными местами;',
  '• <b>брони</b> — брони, которые ждут подтверждения оператора, с контактами туристов;',
  '• <b>заявки</b> — заявки без ответа человека, с контактами;',
  '• <b>сводка</b> — посетители, MCP, A2A и ответы Кузьмича за сегодня и вчера;',
  '• <b>здоровье</b> — последний прогон сторожа платформы: что проверено, сколько тревог.',
  '',
  'Действия с кнопкой подтверждения (открыть даты за оператора, пост в канал, статус заявки или брони) — следующим шагом.',
].join('\n');

/** «2026-10-25» → «25.10». */
function dm(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

/** Склеить строки, не перешагнув предел сообщения; хвост называется числом. */
export function fitLines(head: string[], items: string[], limit = ADMIN_MAX_MESSAGE_CHARS): string {
  const out = [...head];
  let size = out.join('\n').length;
  let shown = 0;
  for (const line of items) {
    if (size + line.length + 1 > limit - 40) break;
    out.push(line);
    size += line.length + 1;
    shown++;
  }
  if (shown < items.length) out.push(`…и ещё ${items.length - shown} — откройте админку.`);
  return out.join('\n');
}

// ── даты ────────────────────────────────────────────────────────────────

export async function readOpenDates(nowMs: number = Date.now()): Promise<AdminReply> {
  let tours: Array<{ id: string; title: string; operator: string | null }>;
  try {
    const { rows } = await pool.query<{ id: string; title: string; operator: string | null }>(
      `SELECT ot.id::text AS id, ot.title, COALESCE(p.company_name, p.name) AS operator
         FROM operator_tours ot
         LEFT JOIN partners p ON p.id = ot.operator_id
        WHERE ${publicTourSql('ot')}
        ORDER BY operator NULLS LAST, ot.title
        LIMIT ${TOURS_LIMIT}`,
    );
    tours = rows;
  } catch (err) {
    console.error('[max/admin] туры витрины не прочитаны, SQLSTATE', sqlstate(err));
    return { text: 'Даты не прочитались: база не ответила. Это не «дат нет» — спросите чуть позже.', pd: false };
  }
  if (tours.length === 0) return { text: 'На витрине нет ни одного тура — открытых дат нет.', pd: false };

  const from = kamchatkaToday(nowMs);
  const to = new Date(Date.parse(from) + (ADMIN_DATES_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const cache = createPlannerCache();
  // Строка — тур целиком, с оператором впереди: «и ещё N» считает туры, и
  // заголовок оператора не остаётся без туров под ним, когда список обрезан.
  const items: string[] = [];
  let withDates = 0;
  let unchecked = 0;
  for (const t of tours) {
    const who = `${escapeHtml(t.operator ?? 'оператор не указан')} · ${escapeHtml(t.title)}`;
    try {
      const slots = await fetchAvailabilityForTour(t.id, from, to, cache);
      if (slots.length === 0) {
        items.push(`• ${who}: открытых дат нет`);
      } else {
        withDates++;
        const shown = slots.slice(0, 8).map((s) => `${dm(s.date)} — ${s.remaining}`).join(', ');
        items.push(`• ${who}: ${shown}${slots.length > 8 ? ` и ещё ${slots.length - 8}` : ''}`);
      }
    } catch (err) {
      console.error('[max/admin] даты тура не проверены, SQLSTATE', sqlstate(err));
      unchecked++;
      items.push(`• ${who}: даты не проверились`);
    }
  }
  const head = [
    `<b>Открытые даты ${dm(from)}–${dm(to)}</b> (по Камчатке; число — свободные места с учётом броней)`,
    `Туров на витрине: ${tours.length}${tours.length === TOURS_LIMIT ? ' (показаны первые)' : ''}, с открытыми датами: ${withDates}`
      + (unchecked > 0 ? `, не проверились: ${unchecked}` : '') + '.',
  ];
  return { text: fitLines(head, items), pd: false };
}

// ── брони ───────────────────────────────────────────────────────────────

interface BookingRow {
  id: string; booking_date: string; participants: number; tourist_name: string | null; tourist_phone: string | null;
  age_h: number; title: string | null; operator: string | null; total: number;
}

export async function readPendingBookings(): Promise<AdminReply> {
  let rows: BookingRow[];
  try {
    ({ rows } = await pool.query<BookingRow>(
      `SELECT ob.id::text AS id, ob.booking_date::text AS booking_date, ob.participants,
              ob.tourist_name, ob.tourist_phone,
              FLOOR(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - ob.created_at)) / 3600)::int AS age_h,
              ot.title, COALESCE(p.company_name, p.name) AS operator,
              COUNT(*) OVER ()::int AS total
         FROM operator_bookings ob
         LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
         LEFT JOIN partners p ON p.id = ot.operator_id
        WHERE ob.booking_status = 'new' AND ob.deleted_at IS NULL
        ORDER BY ob.created_at ASC
        LIMIT ${LIST_LIMIT}`,
    ));
  } catch (err) {
    console.error('[max/admin] брони не прочитаны, SQLSTATE', sqlstate(err));
    return { text: 'Брони не прочитались: база не ответила. Это не «броней нет» — спросите чуть позже.', pd: false };
  }
  if (rows.length === 0) return { text: 'Броней, которые ждут подтверждения оператора, нет.', pd: false };
  const total = rows[0].total;
  const items = rows.map((r) => {
    const age = r.age_h >= 48 ? `ждёт ${r.age_h} ч — оператор молчит больше двух суток`
      : r.age_h >= 24 ? `ждёт ${r.age_h} ч — больше суток` : `ждёт ${r.age_h} ч`;
    const who = [r.tourist_name, r.tourist_phone].filter(Boolean).map(escapeHtml).join(', ') || 'контакт не записан';
    return `• №${r.id} · ${escapeHtml(r.title ?? 'тур удалён')} · ${escapeHtml(r.operator ?? 'оператор не указан')} · `
      + `${dm(r.booking_date)} · ${r.participants} чел · ${who} · ${age}`;
  });
  const head = [`<b>Ждут подтверждения оператора: ${total}</b>${total > rows.length ? ` (показаны ${rows.length} старших)` : ''}`];
  return { text: fitLines(head, items), pd: true };
}

// ── заявки ──────────────────────────────────────────────────────────────

interface LeadRow {
  id: string; name: string | null; phone: string | null; route_title: string | null;
  age_h: number; addressee: string | null; kind: string; total: number;
}

export async function readWaitingLeads(): Promise<AdminReply> {
  let rows: LeadRow[];
  try {
    // Предикат псевдолида — по колонкам leads без алиаса: отбор внутри CTE,
    // до соединения с partners, где `name` есть у обеих таблиц.
    ({ rows } = await pool.query<LeadRow>(
      `WITH l AS (
         SELECT id, name, phone, route_title, created_at, operator_id, source_data
           FROM leads
          WHERE status = ANY($1::text[]) AND NOT ${WIDGET_CHAT_PSEUDO_LEAD_SQL}
       )
       SELECT l.id::text AS id, l.name, l.phone, l.route_title,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - l.created_at)) / 3600)::int AS age_h,
              COALESCE(p.company_name, p.name) AS addressee,
              COALESCE(l.source_data->>'type', '') AS kind,
              COUNT(*) OVER ()::int AS total
         FROM l
         LEFT JOIN partners p ON p.id = l.operator_id
        ORDER BY l.created_at ASC
        LIMIT ${LIST_LIMIT}`,
      [[...UNATTENDED_LEAD_STATUSES]],
    ));
  } catch (err) {
    console.error('[max/admin] заявки не прочитаны, SQLSTATE', sqlstate(err));
    return { text: 'Заявки не прочитались: база не ответила. Это не «заявок нет» — спросите чуть позже.', pd: false };
  }
  if (rows.length === 0) return { text: 'Заявок без ответа человека нет.', pd: false };
  const total = rows[0].total;
  const items = rows.map((r) => {
    const who = [r.name, r.phone].filter(Boolean).map(escapeHtml).join(', ') || 'контакт не записан';
    const what = r.route_title ? escapeHtml(r.route_title) : r.kind ? escapeHtml(r.kind) : 'без темы';
    const to = r.addressee ? `оператору ${escapeHtml(r.addressee)}` : 'без адресата';
    const age = r.age_h >= 2 ? `ждёт ${r.age_h} ч — больше двух часов` : 'меньше двух часов';
    return `• ${who} · ${what} · ${to} · ${age}`;
  });
  const head = [`<b>Заявки без ответа человека: ${total}</b>${total > rows.length ? ` (показаны ${rows.length} старших)` : ''}`];
  return { text: fitLines(head, items), pd: true };
}

// ── сводка ──────────────────────────────────────────────────────────────

function metricLine<T>(label: string, m: Metric<T>, show: (v: T) => string): string {
  return m.ok ? `• ${label}: сегодня ${show(m.today)}, вчера ${show(m.yesterday)}` : `• ${label}: не загрузилось`;
}

export async function readDaySummaryText(now: Date = new Date()): Promise<AdminReply> {
  try {
    const s = await readDaySummary(now);
    return {
      text: [
        `<b>Сводка суток</b> (по Камчатке, сегодня ${dm(s.today)} — до текущей минуты)`,
        metricLine('Люди', s.people, (v) => `${v.visitors} посетителей, ${v.views} просмотров`),
        metricLine('MCP', s.mcp, (v) => `${v.calls} вызовов от ${v.callers}`),
        metricLine('A2A', s.a2a, (v) => `${v.requests} запросов от ${v.callers}`),
        metricLine('Кузьмич', s.kuzmich, (v) => `${v.answers} ответов`),
      ].join('\n'),
      pd: false,
    };
  } catch (err) {
    console.error('[max/admin] сводка не собрана:', err instanceof Error ? err.message.slice(0, 200) : String(err));
    return { text: 'Сводка не собралась. Числа — в админке, в полосе обзора.', pd: false };
  }
}

// ── здоровье ────────────────────────────────────────────────────────────

interface RunRow {
  status: string; ended_at: string; age_min: number; error_msg: string | null;
  alerts: number | null; alert_types: string[] | null;
}

export async function readHealth(): Promise<AdminReply> {
  let row: RunRow | undefined;
  try {
    const { rows } = await pool.query<RunRow>(
      `SELECT r.status, r.ended_at::text AS ended_at,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - r.ended_at)) / 60)::int AS age_min,
              r.error_msg,
              CASE WHEN jsonb_typeof(r.metadata->'alerts') = 'array' THEN jsonb_array_length(r.metadata->'alerts') END AS alerts,
              (SELECT array_agg(DISTINCT a->>'type')
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.metadata->'alerts') = 'array'
                                                THEN r.metadata->'alerts' ELSE '[]'::jsonb END) a) AS alert_types
         FROM agent_run_history r
        WHERE r.agent_id = 'watchdog'
        ORDER BY r.ended_at DESC
        LIMIT 1`,
    );
    row = rows[0];
  } catch (err) {
    console.error('[max/admin] прогон сторожа не прочитан, SQLSTATE', sqlstate(err));
    return { text: 'Состояние не прочиталось: база не ответила. Это не «всё в порядке».', pd: false };
  }
  if (!row) return { text: 'Сторож платформы (Watchdog) ещё ни разу не записал прогон — состояние неизвестно.', pd: false };
  const when = row.age_min < 60 ? `${row.age_min} мин назад` : `${Math.floor(row.age_min / 60)} ч назад`;
  const late = row.age_min > 85 ? ' — дольше обычного, сторож мог остановиться' : '';
  const verdict = row.status === 'success' ? 'всё проверено'
    : row.status === 'partial' ? `проверено не всё: ${escapeHtml(row.error_msg ?? 'причина не записана')}`
      : `прогон упал: ${escapeHtml(row.error_msg ?? 'причина не записана')}`;
  const alerts = row.alerts === null ? 'тревоги в прогоне не записаны'
    : row.alerts === 0 ? 'тревог нет'
      : `тревог: ${row.alerts} (${(row.alert_types ?? []).filter(Boolean).map(escapeHtml).join(', ') || 'виды не записаны'})`;
  return {
    text: [`<b>Сторож платформы</b>: последний прогон ${when}${late}.`, `• ${verdict};`, `• ${alerts}.`,
      'Подробно — в админке, раздел «Здоровье».'].join('\n'),
    pd: false,
  };
}

/** Ответ на команду. help — текст подсказки. */
export async function adminReplyFor(cmd: AdminCommand, nowMs: number = Date.now()): Promise<AdminReply> {
  switch (cmd) {
    case 'help': return { text: ADMIN_HELP_TEXT, pd: false };
    case 'dates': return readOpenDates(nowMs);
    case 'bookings': return readPendingBookings();
    case 'leads': return readWaitingLeads();
    case 'summary': return readDaySummaryText(new Date(nowMs));
    case 'health': return readHealth();
  }
}
