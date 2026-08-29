/**
 * OperatorAgency — агент для операторов турплатформы.
 *
 * READ:
 *   op_tours_summary  — список туров с заполненностью и ближайшими датами
 *   op_bookings_today — бронирования за сегодня
 *   op_revenue        — выручка за 7/30 дней
 *
 * WRITE (через ядро Volcano OS: policy allow/deny + задача + события):
 *   op_create_tour    — создать черновик тура из текста
 *   op_fill_ai        — запустить AI-заполнение тура
 *   op_add_slots      — добавить слоты доступности
 */

import { pool } from '@/lib/db-pool';
import { runAutoFillAI } from '@/app/api/operator/tours/auto-fill-ai/route';
import type { AgentContext } from '../context-hub';

export interface KbFreshnessStats {
  rdc_total:        number;
  rdc_stale:        number;
  rdc_last_updated: string | null;
  tours_total:      number;
  tours_stale:      number;
  tours_last_updated: string | null;
}

interface RdcFreshnessRow {
  total: string;
  stale: string;
  last_updated: string | null;
}

export async function getKbFreshnessStats(): Promise<KbFreshnessStats> {
  const [rdc, tours] = await Promise.all([
    pool.query<RdcFreshnessRow>(
      `SELECT
         COUNT(*)::text                                                          AS total,
         COUNT(*) FILTER (WHERE generated_at < NOW() - INTERVAL '30 days')::text AS stale,
         MAX(generated_at)::text                                                AS last_updated
       FROM route_description_cache`,
    ),
    pool.query<RdcFreshnessRow>(
      `SELECT
         COUNT(*)::text                                                          AS total,
         COUNT(*) FILTER (WHERE updated_at < NOW() - INTERVAL '30 days')::text  AS stale,
         MAX(updated_at)::text                                                   AS last_updated
       FROM operator_tours
       WHERE deleted_at IS NULL`,
    ),
  ]);

  return {
    rdc_total:          Number(rdc.rows[0]?.total   ?? 0),
    rdc_stale:          Number(rdc.rows[0]?.stale   ?? 0),
    rdc_last_updated:   rdc.rows[0]?.last_updated   ?? null,
    tours_total:        Number(tours.rows[0]?.total  ?? 0),
    tours_stale:        Number(tours.rows[0]?.stale  ?? 0),
    tours_last_updated: tours.rows[0]?.last_updated  ?? null,
  };
}

export interface AgencyResult {
  response: string;
  data?: Record<string, unknown>;
}

interface TourSummaryRow {
  id: number;
  title: string;
  base_price: number;
  bookings_count: string;
  next_date: string | null;
  available_slots: string | null;
}

interface BookingTodayRow {
  id: string;
  tour_title: string;
  tourist_name: string;
  participants: number;
  final_price: number;
  status: string;
}

interface RevenueRow {
  revenue_7d: string | null;
  revenue_30d: string | null;
  bookings_7d: string;
  bookings_30d: string;
}

interface PartnerRow { id: number }

export class OperatorAgency {
  async run(intent: string, context: AgentContext, originalMessage = ''): Promise<AgencyResult> {
    switch (intent) {
      case 'op_tours_summary':  return this.getToursSummary(context);
      case 'op_bookings_today': return this.getBookingsToday(context);
      case 'op_revenue':        return this.getRevenue(context);
      case 'op_create_tour':    return this.createTour(context, originalMessage);
      case 'op_fill_ai':        return this.fillAI(context, originalMessage);
      case 'op_add_slots':      return this.addSlots(context, originalMessage);
      default:                  return { response: 'OperatorAgency: команда не поддерживается.' };
    }
  }

  private async getPartnerId(userId: number | undefined): Promise<number | null> {
    if (!userId) return null;
    // category='operator': один user_id может держать несколько записей
    // partners (гид+оператор — обычный случай), LIMIT 1 без фильтра и
    // ORDER BY возвращал бы произвольную из них (аудит кабинета оператора).
    const { rows } = await pool.query<PartnerRow>(
      `SELECT id FROM partners WHERE user_id = $1 AND category = 'operator' ORDER BY created_at ASC LIMIT 1`,
      [userId]
    );
    return rows[0]?.id ?? null;
  }

  async getToursSummary(context: AgentContext): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    const { rows } = await pool.query<TourSummaryRow>(`
      SELECT
        t.id,
        t.title,
        t.base_price,
        COUNT(b.id) FILTER (WHERE b.booking_status NOT IN ('cancelled') AND b.deleted_at IS NULL)::text AS bookings_count,
        MIN(a.date)::text  AS next_date,
        SUM(a.available_slots) FILTER (WHERE a.is_cancelled = FALSE AND a.date >= NOW()::date)::text AS available_slots
      FROM operator_tours t
      LEFT JOIN operator_bookings b  ON b.operator_tour_id = t.id
      LEFT JOIN tour_availability  a ON a.operator_tour_id = t.id AND a.date >= NOW()::date
      WHERE t.operator_id = $1 AND t.deleted_at IS NULL
      GROUP BY t.id
      ORDER BY t.title
      LIMIT 10
    `, [partnerId]);

    if (rows.length === 0) {
      return { response: 'Туры не найдены. Создайте первый тур в разделе "Туры".' };
    }

    const lines = ['<b>Ваши туры:</b>', ''];
    for (const r of rows) {
      const slots = r.available_slots ? `${r.available_slots} мест` : 'нет слотов';
      const next  = r.next_date ? ` | след. ${r.next_date}` : '';
      lines.push(`${r.title} — от ${Number(r.base_price).toLocaleString('ru-RU')} руб | ${slots}${next}`);
    }

    return { response: lines.join('\n'), data: { tours: rows } };
  }

  async getBookingsToday(context: AgentContext): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    const { rows } = await pool.query<BookingTodayRow>(`
      SELECT b.id, t.title AS tour_title, b.tourist_name, b.participants, b.final_price, b.booking_status AS status
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      WHERE t.operator_id = $1
        AND b.created_at >= NOW()::date
        AND b.deleted_at IS NULL
      ORDER BY b.created_at DESC
    `, [partnerId]);

    if (rows.length === 0) return { response: 'Бронирований сегодня нет.' };

    const lines = [`<b>Бронирования сегодня (${rows.length}):</b>`, ''];
    for (const r of rows) {
      lines.push(
        `${r.tour_title} — ${r.tourist_name}, ${r.participants} чел, ` +
        `${Number(r.final_price).toLocaleString('ru-RU')} руб [${r.status}]`
      );
    }

    return { response: lines.join('\n'), data: { bookings: rows } };
  }

  async getRevenue(context: AgentContext): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    const { rows } = await pool.query<RevenueRow>(`
      SELECT
        SUM(b.final_price) FILTER (WHERE b.created_at >= NOW() - INTERVAL '7 days')::text  AS revenue_7d,
        SUM(b.final_price) FILTER (WHERE b.created_at >= NOW() - INTERVAL '30 days')::text AS revenue_30d,
        COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '7 days')::text            AS bookings_7d,
        COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '30 days')::text           AS bookings_30d
      FROM operator_bookings b
      JOIN operator_tours t ON t.id = b.operator_tour_id
      WHERE t.operator_id = $1
        AND b.booking_status NOT IN ('cancelled')
        AND b.deleted_at IS NULL
    `, [partnerId]);

    const r = rows[0] ?? { revenue_7d: null, revenue_30d: null, bookings_7d: '0', bookings_30d: '0' };
    const fmt = (v: string | null) =>
      v ? `${Number(v).toLocaleString('ru-RU')} руб` : '0 руб';

    const response = [
      '<b>Ваша выручка:</b>',
      `7 дней: ${fmt(r.revenue_7d)} (${r.bookings_7d} бронирований)`,
      `30 дней: ${fmt(r.revenue_30d)} (${r.bookings_30d} бронирований)`,
    ].join('\n');

    return { response, data: { revenue: r } };
  }

  // ── Write: создать тур ────────────────────────────────────────────────────────────

  async createTour(context: AgentContext, message: string): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    // Извлечь заголовок и цену из сообщения простыми эвристиками
    const priceMatch = message.match(/(\d[\d\s]{2,8})/);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, ''), 10) : null;

    // Заголовок — первое предложение или всё сообщение (макс. 120 символов)
    const rawTitle = message.replace(/создай|новый тур|тур|за \d+/gi, '').trim().slice(0, 120);
    const title = rawTitle || 'Новый тур';

    // Черновик — через ядро Volcano OS: policy allow/deny + задача + события.
    // Прежний путь через ApprovalRequired (auto-approve с аудит-строкой)
    // снят 27.08: аудит и полномочия теперь держит kernel, agent_approvals
    // осталась legacy-хранилищем старых одобрений.
    const { executeGovernedAction, hashInput } = await import('@/lib/agents/kernel');
    const gov = await executeGovernedAction<{ id: number; title: string }>({
      principal: { type: 'operator', id: String(partnerId) },
      capability: 'tour.create_draft',
      inputHash: hashInput({ partnerId, title, price }),
      execute: async () => {
        const { rows } = await pool.query<{ id: number; title: string }>(
          `INSERT INTO operator_tours (operator_id, title, base_price, is_published, created_via)
           VALUES ($1, $2, $3, false, 'agent')
           RETURNING id, title`,
          [partnerId, title, price ?? 0]
        );
        return rows[0];
      },
      summarize: (t) => `черновик тура ${t.id}: "${t.title}"`,
    });

    if (!gov.ok) return { response: `Запрос отклонён: ${gov.reason}` };
    if (gov.duplicate) return { response: 'Этот черновик уже создан ранее — повтор не выполнялся.' };

    const tour = gov.result;
    return {
      response: `Черновик тура создан.\nНазвание: ${tour.title}\nID: ${tour.id}\nЗапусти AI-заполнение командой: "заполни тур ${tour.id}"`,
      data: { tourId: tour.id, title: tour.title },
    };
  }

  // ── Write: AI-заполнение тура ──────────────────────────────────────────────

  async fillAI(context: AgentContext, message: string): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    const idMatch = message.match(/\b(\d{1,8})\b/);
    if (!idMatch) {
      return { response: 'Укажи ID тура. Пример: "заполни тур 42"' };
    }
    const tourId = idMatch[1];

    // Раньше здесь был внутренний fetch на /api/operator/tours/auto-fill-ai
    // без cookie/JWT — requireOperator того роута всегда отвечал 401, и
    // команда «заполни тур N» не работала НИКОГДА (аудит кабинета
    // оператора). Владение здесь уже проверено (partnerId), поэтому логика
    // зовётся напрямую, в процессе — HTTP-прыжок был чистым риском без пользы.
    try {
      const outcome = await runAutoFillAI(String(partnerId), tourId);
      const body = outcome.body as { success?: boolean; error?: string };

      if (outcome.status >= 400 || !body.success) {
        return { response: `Ошибка AI-заполнения: ${body.error ?? outcome.status}` };
      }

      return {
        response: `AI-заполнение тура ${tourId} запущено. Поля обновлены автоматически.`,
        data:     { tourId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { response: `Не удалось запустить AI-заполнение: ${msg}` };
    }
  }

  // ── Write: добавить слоты доступности ─────────────────────────────────────────────

  async addSlots(context: AgentContext, message: string): Promise<AgencyResult> {
    const partnerId = await this.getPartnerId(context.user.userId);
    if (!partnerId) return { response: 'Профиль оператора не найден.' };

    // Парсим: tour ID, дата начала, дата конца, кол-во мест
    const idMatch    = message.match(/тур(?:у|ам?)\s+(\d+)/i);
    const datesMatch = message.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
    const slotsMatch = message.match(/(\d+)\s*(?:мест|чел|человек)/i);

    if (!idMatch || !datesMatch) {
      return {
        response:
          'Укажи ID тура, даты и (опционально) количество мест.\n' +
          'Пример: "добавь слоты туру 42 с 2026-07-01 по 2026-07-31, 10 мест"',
      };
    }

    const tourId   = parseInt(idMatch[1], 10);
    const dateFrom = datesMatch[1];
    const dateTo   = datesMatch[2];
    const slots    = slotsMatch ? parseInt(slotsMatch[1], 10) : 10;

    // Генерируем список дат между dateFrom и dateTo
    const dates: string[] = [];
    const cur = new Date(dateFrom);
    const end = new Date(dateTo);
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }

    if (dates.length === 0) return { response: 'Некорректный диапазон дат.' };
    if (dates.length > 366)  return { response: 'Диапазон дат слишком большой (макс. 366 дней).' };

    // Через ядро Volcano OS (P2, 28.08): владение туром теперь проверяет
    // policy (operatorOwnsTour, capability tour.add_slots) вместо инлайн-SQL
    // здесь — тот же путь, что у createTour/set_tour_published/update_price.
    // Ключа идемпотентности нет намеренно (тот же выбор, что у createTour):
    // сам эффект уже безопасен к повтору (ON CONFLICT DO NOTHING на уровне
    // строк ниже) — governed-action здесь даёт не защиту от дублирования
    // (она уже есть), а единый аудит-след и policy вместо инлайн-владения.
    const { executeGovernedAction, hashInput } = await import('@/lib/agents/kernel');
    const gov = await executeGovernedAction<{ inserted: number }>({
      principal: { type: 'operator', id: String(partnerId) },
      capability: 'tour.add_slots',
      resource: { type: 'tour', id: String(tourId) },
      inputHash: hashInput({ partnerId, tourId, dateFrom, dateTo, slots }),
      execute: async () => {
        let inserted = 0;
        for (const date of dates) {
          const { rowCount } = await pool.query(
            `INSERT INTO tour_availability (operator_tour_id, date, available_slots, booked_slots, is_cancelled)
             VALUES ($1, $2, $3, 0, false)
             ON CONFLICT (operator_tour_id, date) DO NOTHING`,
            [tourId, date, slots]
          );
          inserted += rowCount ?? 0;
        }
        return { inserted };
      },
      summarize: (r) => `слоты тура ${tourId}: +${r.inserted} (${dateFrom} — ${dateTo}, ${slots}/день)`,
    });

    if (!gov.ok) return { response: `Запрос отклонён: ${gov.reason}` };
    if (gov.duplicate) return { response: 'Этот запрос уже выполнялся — повтор не выполнялся.' };

    const { inserted } = gov.result;
    return {
      response:
        `Добавлено ${inserted} слотов для тура ${tourId}.\n` +
        `Период: ${dateFrom} — ${dateTo}, ${slots} мест на день.\n` +
        `(${dates.length - inserted} дат уже существовало)`,
      data: { tourId, dateFrom, dateTo, slots, inserted },
    };
  }
}

// ── Всплеск регистраций операторов ───────────────────────────────────────────
//
// Сторож — Watchdog (`checkOperatorRegistrationSpike`). До 22.08.2026 функция
// была подписана «used by health cron» и не вызывалась ниоткуда: подпись
// описывала намерение, а не связь.

export interface RegistrationSpikeResult {
  today: number;
  baseline_median: number;
  is_spike: boolean;
  /**
   * Три исхода, а не два. `unknown` — за две недели не было ни одной
   * регистрации, кроме сегодняшних: сравнивать не с чем. Ноль в знаменателе
   * не означает «спокойно», и выдавать его за спокойствие нельзя.
   */
  verdict: 'spike' | 'normal' | 'unknown';
}

export async function detectRegistrationSpike(): Promise<RegistrationSpikeResult> {
  const { rows } = await pool.query<{ day: string; cnt: string }>(
    `SELECT
       DATE_TRUNC('day', created_at)::date::text AS day,
       COUNT(*)::int                              AS cnt
     FROM partners
     WHERE category = 'operator'
       AND created_at >= NOW() - INTERVAL '14 days'
     GROUP BY DATE_TRUNC('day', created_at)
     ORDER BY day DESC`,
  );

  if (rows.length === 0) return { today: 0, baseline_median: 0, is_spike: false, verdict: 'unknown' };

  const todayStr = new Date().toISOString().slice(0, 10);
  const today    = Number(rows.find(r => r.day === todayStr)?.cnt ?? 0);

  const history  = rows
    .filter(r => r.day !== todayStr)
    .map(r => Number(r.cnt))
    .sort((a, b) => a - b);

  let baseline_median = 0;
  if (history.length > 0) {
    const mid = Math.floor(history.length / 2);
    baseline_median = history.length % 2 === 0
      ? (history[mid - 1] + history[mid]) / 2
      : history[mid];
  }

  if (baseline_median === 0) return { today, baseline_median, is_spike: false, verdict: 'unknown' };

  const is_spike = today > baseline_median * 3;
  return { today, baseline_median, is_spike, verdict: is_spike ? 'spike' : 'normal' };
}
