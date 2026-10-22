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
 *   op_add_slots      — открыть даты тура (общей функцией lib/tours/availability-open)
 */

import { pool } from '@/lib/db-pool';
import { runAutoFillAI } from '@/app/api/operator/tours/auto-fill-ai/route';
import type { AgentContext } from '../context-hub';
import { managerMay, operatorAccess, type ManagerPermission } from '@/lib/operators/team-access';
import {
  MAX_SLOTS_PER_DATE, datesInRange, isCalendarDate, openTourDates, tourHiddenText,
  type DateOpenKind, type DateOpenResult, type OpenDatesOutcome, type OpenDatesResult,
} from '@/lib/tours/availability-open';
import {
  ISO_DATE_IN_PHRASE, dayFilterWord, datesPhraseRefusal, isoDatesInPhrase, phraseMentionsPrice,
  type DatesPhraseRefusal,
} from '@/lib/tours/dates-phrase';
import { longDay, windowLabel } from '@/lib/tours/request-window';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { peopleWord, seatsWord } from '@/lib/operators/chat-dates/texts';

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


/** Кабинет найден — или текст отказа для ответа помощника. */
type Cabinet = { partnerId: string } | { denied: string };

/** Отказы по правам команды (CRM 2г): деньги — владельцу, цены — по праву. */
const NEED_DENIED: Record<'owner' | ManagerPermission, string> = {
  owner: 'Выручку видит владелец кабинета: деньги менеджеру закрыты.',
  can_edit_prices: 'Тур с ценой создаёт владелец кабинета или менеджер, которому он разрешил цены.',
  can_cancel_bookings: 'Отменить бронь может владелец кабинета или менеджер, которому он это разрешил.',
};

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

  /**
   * Кабинет вошедшего: свой у владельца или командный у менеджера (CRM 2г-2,
   * operatorAccess). need — что команда требует сверх входа: 'owner' (деньги)
   * или право менеджера, которое даёт владелец. Отказ — текстом для ответа:
   * «не смогли проверить» говорит о сбое, а не о том, что профиля нет (§4.0).
   * До 13.10 кабинет искался своим запросом по partners.user_id, и менеджер
   * команды получал «Профиль оператора не найден» на любую команду.
   */
  private async cabinet(userId: string | undefined, need?: 'owner' | ManagerPermission): Promise<Cabinet> {
    if (!userId) return { denied: 'Профиль оператора не найден.' };
    const access = await operatorAccess(userId);
    if (access.kind === 'unavailable') return { denied: 'Не удалось проверить доступ к кабинету — попробуйте позже.' };
    if (access.kind === 'none') {
      return { denied: access.reason === 'revoked' ? 'Владелец кабинета закрыл вам доступ.' : 'Профиль оператора не найден.' };
    }
    if (need === 'owner' && access.kind !== 'owner') return { denied: NEED_DENIED.owner };
    if (need && need !== 'owner' && !managerMay(access, need)) return { denied: NEED_DENIED[need] };
    return { partnerId: access.partnerId };
  }

  async getToursSummary(context: AgentContext): Promise<AgencyResult> {
    const cab = await this.cabinet(context.user.userId);
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

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
    const cab = await this.cabinet(context.user.userId);
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

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
    const cab = await this.cabinet(context.user.userId, 'owner');
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

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
    const cab = await this.cabinet(context.user.userId, 'can_edit_prices');
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

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
    const cab = await this.cabinet(context.user.userId);
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

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

  // ── Write: открыть даты ───────────────────────────────────────────────────────────

  /**
   * «Открой даты» / «добавь слоты туру 42 с 2027-07-01 по 2027-07-31, 8 мест».
   *
   * Запись — общей функцией `openTourDates` (lib/tours/availability-open.ts,
   * 22.10), той же, что у кабинета, с правилами чата кабинета (решения
   * владельца 22.10): уже открытые даты не трогаются, закрытые оператором — не
   * открываются (их открывают в кабинете), даты вне сезона тура, прошедшие и
   * дальше года вперёд — тоже; скрытому туру даты не открываются; ниже числа
   * уже записанных места не ставятся. Ответ называет исход каждой даты.
   *
   * Число мест называет оператор. До 22.10 без числа подставлялось 10 —
   * выдуманное число (§4.0): помощник открывал даты на десять мест, о которых
   * никто не говорил. Теперь без числа — вопрос, и ничего не пишется.
   *
   * Сюда фразу ведёт ключ классификатора («слоты на», «новые слоты»), а он не
   * видит, чего просят: «закрой слоты на …», «заблокируй слоты на …» и вопрос
   * «есть ли свободные слоты на … для 8 человек?» тоже приходят сюда. Поэтому
   * первым делом, до прав и чисел (lib/tours/dates-phrase): нужен глагол
   * открытия, и нет ни закрытия, ни отрицания, ни исключения, ни вопроса.
   *
   * Даты — числами ISO. Две даты — диапазон только при явной связке («с … по
   * …», тире, дефис); «A и B», «A, B» — ровно эти даты; связка не названа —
   * вопрос. Дни недели («по субботам», «выходные») помощник не разбирает и
   * отказывает словами: до 22.10 он их молча отбрасывал и открывал каждый день
   * диапазона (ревью 22.10).
   */
  async addSlots(context: AgentContext, message: string): Promise<AgencyResult> {
    const refusal = datesPhraseRefusal(message);
    if (refusal) return { response: phraseRefusalText(refusal) };
    const dayWord = dayFilterWord(message);
    if (dayWord) return { response: dayFilterText(dayWord) };

    const cab = await this.cabinet(context.user.userId);
    if ('denied' in cab) return { response: cab.denied };
    const { partnerId } = cab;

    // Номер тура: «туру 42», «тура 42» и «тур 42» — так дописывает его роут
    // /api/agents/operator из поля «Tour ID» экрана помощника. Два разных
    // номера — вопрос, а не первый попавшийся. Год даты («тур 2027-07-05»)
    // номером тура не считается.
    const tourIds = [...new Set([...message.matchAll(TOUR_ID)].map((m) => m[1]!))];
    if (tourIds.length > 1) {
      return { response: `Назвали несколько туров (${tourIds.join(', ')}) — напишите один. Ничего не открыто.` };
    }
    const found = isoDatesInPhrase(message);
    if (tourIds.length === 0 || found.kind === 'none') return { response: ADD_SLOTS_HELP };
    const seats = seatsInMessage(message);
    if (found.kind === 'unclear') {
      return { response: unclearDatesText(found.dates, tourIds[0]!, seats.kind === 'one' ? seats.value : null) };
    }

    if (seats.kind === 'none') {
      const example = found.kind === 'range' ? `с ${found.from} по ${found.to}` : found.dates.join(' и ');
      return {
        response:
          'Сколько мест открыть на каждую дату? Напишите команду с числом, например: ' +
          `"добавь слоты туру ${tourIds[0]} ${example}, 8 мест". Ничего не открыто.`,
      };
    }
    if (seats.kind === 'two') {
      return { response: `Назвали два числа мест (${seats.values.join(' и ')}) — напишите одно. Ничего не открыто.` };
    }
    if (seats.kind === 'bad') {
      return { response: `Мест на дату — от 1 до ${MAX_SLOTS_PER_DATE}, а названо ${seats.value}. Ничего не открыто.` };
    }

    const tourId = parseInt(tourIds[0]!, 10);
    const slots  = seats.value;
    const named  = found.kind === 'range' ? [found.from, found.to] : found.dates;
    const notADay = named.find((d) => !isCalendarDate(d));
    if (notADay) return { response: `Такой даты нет в календаре: ${notADay}. Ничего не открыто.` };
    let dates: string[];
    if (found.kind === 'range') {
      if (found.to < found.from) return { response: 'Некорректный диапазон дат: конец раньше начала.' };
      dates = datesInRange(found.from, found.to);
      if (dates.length === 0) return { response: 'Диапазон дат слишком большой (не больше 366 дней).' };
    } else {
      dates = found.dates;
    }
    const span = spanText(dates, found.kind === 'range');

    // Через ядро Volcano OS (P2, 28.08): владение туром проверяет policy
    // (operatorOwnsTour, capability tour.add_slots) — тот же путь, что у
    // createTour/set_tour_published/update_price; сама запись ещё раз проверяет
    // владение и скрытость тура — под блокировкой, в своей транзакции.
    // Ключа идемпотентности нет намеренно (тот же выбор, что у createTour):
    // повтор безопасен сам — открытые даты при повторе приходят «уже открыты».
    // Отказ базы — провал задачи ядра (след в журнале), а не «успех с нулём».
    //
    // Что вернула запись, помнится здесь же: ядро отвечает ok:false и тогда,
    // когда эффект УЖЕ прошёл, а не записался учёт задачи. Даты в этом случае
    // в календаре — и сказать «не открыты» было бы неправдой (§4.0).
    const today = kamchatkaToday();
    const effect: { result: OpenDatesResult | null } = { result: null };
    const { executeGovernedAction, hashInput } = await import('@/lib/agents/kernel');
    const gov = await executeGovernedAction<OpenDatesOutcome>({
      principal: { type: 'operator', id: String(partnerId) },
      capability: 'tour.add_slots',
      resource: { type: 'tour', id: String(tourId) },
      inputHash: hashInput({ partnerId, tourId, dates, slots }),
      execute: async () => {
        const r = await openTourDates({
          operatorId: String(partnerId),
          tourId: String(tourId),
          rows: dates.map((date) => ({ date, slots })),
          mayPrice: false,
          inactiveTour: 'refuse',
          skipExisting: true,
          closedDates: 'keep',
          today,
          enforceSeason: true,
        });
        effect.result = r;
        if (!isDbFailure(r)) return r;
        throw new Error(`база не ответила (SQLSTATE ${r.sqlstate ?? 'нет'}) — ничего не открыто`);
      },
      summarize: (r) => {
        if (r.ok) return `даты тура ${tourId}: записано ${r.written} из ${r.perDate.length} (${span}, ${slots} мест)`;
        return r.reason === 'tour_inactive'
          ? `даты тура ${tourId}: тур скрыт — ничего не открыто`
          : `даты тура ${tourId}: тур не найден среди туров оператора — ничего не открыто`;
      },
    });

    let outcome: OpenDatesOutcome;
    let journalNote: string | null = null;
    if (gov.ok) {
      if (gov.duplicate) return { response: 'Этот запрос уже выполнялся — повтор не выполнялся.' };
      outcome = gov.result;
    } else {
      const seen = effect.result;
      // Записи не было вовсе (policy, ресурс занят) или база отказала и
      // транзакция откачена — «не открыты» правда.
      if (!seen || isDbFailure(seen)) return { response: `Даты не открыты: ${gov.reason}` };
      outcome = seen;
      journalNote = `Журнал задач помощника не дописан (${gov.reason}); исходы выше — то, что запись уже сделала ` +
        `в календаре. Проверить: ${CALENDAR_PATH}`;
    }

    if (!outcome.ok) {
      const text = outcome.reason === 'tour_inactive'
        ? `${tourHiddenText(outcome.title)} Ничего не открыто.`
        : `Тур ${tourId} не найден среди ваших туров — даты не открыты.`;
      return { response: text };
    }
    const lines = [addSlotsReport(outcome, slots)];
    // Цену помощник не ставит (право цен — кабинету): если она во фразе, это
    // сказано, а не пропущено молча.
    if (phraseMentionsPrice(withoutParsed(message))) lines.push(PRICE_NOT_SET);
    if (journalNote) lines.push(journalNote);
    return {
      response: lines.join('\n'),
      data: { tourId, dateFrom: dates[0], dateTo: dates[dates.length - 1], dates, slots, written: outcome.written, perDate: outcome.perDate },
    };
  }
}

const CALENDAR_PATH = '/hub/operator/calendar';

/**
 * Номер тура во фразе: «туру 42», «тура 42», «тур 42», «тур № 42». Число не
 * должно продолжаться дефисом: «на тур 2027-07-05» — дата, а не тур 2027.
 */
const TOUR_ID = /(?<!\p{L})тур(?:у|а|ам|ом)?\s+(?:№\s*)?(\d+)(?![\d-])/giu;
/** Число мест во фразе (см. seatsInMessage). */
const SEATS = /(?<![\d.,-])(\d+)(?![\d.,])\s*(?:мест|чел)\p{L}*/giu;

const PRICE_NOT_SET =
  'Цену из помощника не меняю: новые даты идут по цене тура, у открытых остаётся своя. ' +
  `Цену на дату ставят в кабинете: ${CALENDAR_PATH}`;

/** Фраза без разобранного: дат, номера тура и мест — остаток судит цену. */
function withoutParsed(message: string): string {
  return message.replace(ISO_DATE_IN_PHRASE, ' ').replace(TOUR_ID, ' ').replace(SEATS, ' ');
}

function isDbFailure(r: OpenDatesResult): r is Extract<OpenDatesResult, { reason: 'failed' }> {
  return !r.ok && r.reason === 'failed';
}

/** Отказ фразе словами: что не так и где это делается. Записи нет. */
export function phraseRefusalText(refusal: DatesPhraseRefusal): string {
  switch (refusal.kind) {
    case 'close':
      return `Закрыть, убрать или уменьшить даты из помощника нельзя (во фразе «${refusal.word}») — это делается ` +
        `в кабинете, в календаре: ${CALENDAR_PATH}. Ничего не изменено.`;
    case 'negation':
      return `Во фразе отказ («${refusal.word}») — даты не открываю. Если их нужно открыть, напишите без отрицания, ` +
        'например: "открой даты туру 42 2027-07-05, 8 мест". Ничего не изменено.';
    case 'exception':
      return `Исключения («${refusal.word}») помощник не разбирает — перечислите даты, которые открыть, ` +
        'например: "открой даты туру 42 с 2027-07-01 по 2027-07-16, 8 мест". Ничего не изменено.';
    case 'question':
      return 'Это вопрос — по вопросу помощник даты не открывает. Что открыто и сколько мест, видно в кабинете, ' +
        `в календаре: ${CALENDAR_PATH}. Открыть: "открой даты туру 42 2027-07-05, 8 мест". Ничего не изменено.`;
    case 'no_open_verb':
      return 'Не понял, что сделать с датами. Открыть — словом «открой» или «добавь», например: ' +
        `"открой даты туру 42 2027-07-05, 8 мест". Закрыть или уменьшить — в кабинете: ${CALENDAR_PATH}. Ничего не изменено.`;
  }
}

/** Отказ дням недели: помощник их не применит, а открывать каждый день диапазона нельзя. */
function dayFilterText(word: string): string {
  return `Дни недели и периодичность («${word}») помощник не разбирает — открыл бы каждый день подряд. ` +
    'Перечислите даты, например: "открой даты туру 42 2027-07-03 и 2027-07-10, 8 мест", ' +
    `или откройте массово в кабинете, там дни недели выбираются: ${CALENDAR_PATH}. Ничего не открыто.`;
}

/**
 * Связь дат не названа: диапазон или перечень — спросить, а не угадать.
 * Подсказка в кавычках — команда целиком («добавь слоты туру 42 …, 8 мест»):
 * голое «с A по B» классификатор помощнику не отдаёт, и ответ по подсказке
 * уходил мимо (второй ревью 22.10). Места — названные, иначе их спросят следом.
 */
function unclearDatesText(dates: string[], tourId: string, seats: number | null): string {
  const cmd = (what: string): string => `"добавь слоты туру ${tourId} ${what}${seats === null ? '' : `, ${seatsWord(seats)}`}"`;
  if (dates.length === 1) {
    return `С какой и по какую дату? Допишите конец после «по»: добавь слоты туру ${tourId} с ${dates[0]} по ГГГГ-ММ-ДД — ` +
      `или откройте только эту дату: ${cmd(dates[0]!)}. Ничего не открыто.`;
  }
  const [a, b] = [dates[0]!, dates[dates.length - 1]!];
  return `Не понял, как связаны даты (${dates.join(', ')}): ${cmd(`с ${a} по ${b}`)} — все дни между ними, ` +
    `${cmd(dates.join(' и '))} — только эти. Ничего не открыто.`;
}

/** Даты для журнала задачи: диапазон — концами, перечень — списком (до пяти). */
function spanText(dates: string[], isRange: boolean): string {
  if (isRange && dates.length > 1) return `${dates[0]} — ${dates[dates.length - 1]}`;
  return dates.length > 5 ? `${dates.slice(0, 5).join(', ')} и ещё ${dates.length - 5}` : dates.join(', ');
}

const ADD_SLOTS_HELP =
  'Укажи ID тура, даты и число мест.\n' +
  'Пример: "добавь слоты туру 42 с 2027-07-01 по 2027-07-31, 8 мест", "открой даты туру 42 2027-07-05, 8 мест" ' +
  'или "открой даты туру 42 2027-07-05 и 2027-07-12, 8 мест". Ничего не открыто.';

type SeatsInMessage =
  | { kind: 'none' }
  | { kind: 'one'; value: number }
  | { kind: 'two'; values: number[] }
  | { kind: 'bad'; value: number };

/**
 * Число мест во фразе: «8 мест», «8 чел», «8 человек». Число берётся целиком:
 * «1500 мест» — это 1500 (отказ), а не 500 с середины числа; хвост даты
 * («2027-07-31 мест») числом мест не считается.
 */
export function seatsInMessage(message: string): SeatsInMessage {
  const found = [...message.matchAll(SEATS)].map((m) => Number(m[1]));
  const distinct = [...new Set(found)];
  if (distinct.length === 0) return { kind: 'none' };
  if (distinct.length > 1) return { kind: 'two', values: distinct };
  const value = distinct[0]!;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SLOTS_PER_DATE) return { kind: 'bad', value };
  return { kind: 'one', value };
}

const LIST_LIMIT = 10;

function listOf<T>(items: T[], show: (item: T) => string): string {
  const shown = items.slice(0, LIST_LIMIT).map(show).join(', ');
  return items.length > LIST_LIMIT ? `${shown} и ещё ${items.length - LIST_LIMIT}` : shown;
}

function only<K extends DateOpenKind>(perDate: DateOpenResult[], kind: K): Array<Extract<DateOpenResult, { result: K }>> {
  return perDate.filter((r): r is Extract<DateOpenResult, { result: K }> => r.result === kind);
}

/** Ответ помощника: исход каждой даты словами, «открыто» — только записанное. */
export function addSlotsReport(outcome: Extract<OpenDatesOutcome, { ok: true }>, slots: number): string {
  const day = (r: { date: string }) => longDay(r.date);
  const lines: string[] = [
    outcome.written > 0
      ? `Тур «${outcome.tour.title}», ${seatsWord(slots)} на дату.`
      : `Ничего не открыто. Тур «${outcome.tour.title}», ${seatsWord(slots)} на дату.`,
  ];
  const opened = only(outcome.perDate, 'opened');
  if (opened.length) lines.push(`Открыто (${opened.length}): ${listOf(opened, day)}`);
  const reopened = only(outcome.perDate, 'reopened');
  if (reopened.length) lines.push(`Открыто снова (${reopened.length}): ${listOf(reopened, day)}`);
  const updated = only(outcome.perDate, 'updated');
  if (updated.length) lines.push(`Места переписаны (${updated.length}): ${listOf(updated, (r) => `${day(r)} — было ${r.from}`)}`);
  const already = only(outcome.perDate, 'already_open');
  if (already.length) {
    lines.push(`Уже были открыты, не трогал (${already.length}): ${listOf(already, (r) => `${day(r)} — ${seatsWord(r.slots)}`)}`);
  }
  const booked = only(outcome.perDate, 'refused_booked');
  if (booked.length) {
    lines.push(`Не открыто — уже записано больше, чем ${seatsWord(slots)} (${booked.length}): ` +
      listOf(booked, (r) => `${day(r)} — записано ${peopleWord(r.taken)}`));
  }
  const closed = only(outcome.perDate, 'refused_closed');
  if (closed.length) {
    lines.push(`Не открыто — дату закрыли вы, открыть её снова можно в кабинете, в календаре (${closed.length}): ` +
      listOf(closed, (r) => (r.reason ? `${day(r)} («${r.reason}»)` : day(r))));
  }
  const season = only(outcome.perDate, 'refused_season');
  if (season.length) {
    const w = season[0]!;
    const label = windowLabel({ kind: 'season', from: w.from, to: w.to, seasonStart: w.seasonStart, seasonEnd: w.seasonEnd });
    lines.push(`Не открыто — вне сезона тура (${label}; сезон меняется в карточке тура) (${season.length}): ${listOf(season, day)}`);
  }
  const past = only(outcome.perDate, 'refused_past');
  if (past.length) lines.push(`Не открыто — дата прошла (${past.length}): ${listOf(past, day)}`);
  const far = only(outcome.perDate, 'refused_horizon');
  if (far.length) lines.push(`Не открыто — дальше года вперёд, туристы такие даты не видят (${far.length}): ${listOf(far, day)}`);
  if (outcome.written > 0 && !outcome.tour.isPublished) lines.push('Тур не опубликован — туристы даты пока не видят.');
  return lines.join('\n');
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
