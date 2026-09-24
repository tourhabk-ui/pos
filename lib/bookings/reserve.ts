/**
 * Место, где заводится ГОСТЕВАЯ бронь тура — из веб-формы и из чата Кузьмича.
 *
 * Заголовок уточнён 14.09. До этого здесь стояло «единственное место, где
 * заводится бронь тура», и это было неправдой: `app/api/bookings/tour`
 * делает свой `INSERT INTO operator_bookings` напрямую, мимо этой функции.
 * Тот путь живёт под `requireAuth` — бронирует вошедший пользователь, чьё
 * согласие на обработку ПД записано при регистрации, — и потому в разговоре
 * про гостевые ПД он не участвует. Но «единственное» он опровергает, а
 * докстрока, обещающая путь, которого нет, — дефект кода (правило 10.09):
 * читающий поверил бы, что согласие теперь несут ВСЕ брони.
 *
 * ── Что было (аудит Fable 5.1, 08.09) ─────────────────────────────────────
 *
 * Копий создания брони было ДВЕ, и они разошлись по трём признакам сразу:
 *
 *   веб-форма (`/api/hub/bookings/create`)   Кузьмич (`lib/kuzmich/core.ts`)
 *   ──────────────────────────────────────   ────────────────────────────────
 *   читает календарь оператора               НЕ читает: бронь принималась
 *   (is_cancelled, лимит слотов на дату)     на дату, закрытую оператором
 *   статус 'new'                             статус 'pending_payment'
 *   пишет user_id вошедшего                  не пишет ничего
 *
 * Третья строка и есть потерянная бронь. `loadUserSituation` ищет брони так:
 * `JOIN users u ON u.id = b.user_id WHERE u.telegram_id = $1` и только со
 * статусами `('new','confirmed')`. Бронь из чата не проходила НИ ПО ОДНОМУ
 * условию: user_id пуст, статус чужой. Турист бронировал у Кузьмича — и тот
 * же Кузьмич через минуту отвечал, что броней у него нет.
 *
 * Это не «показали не то». Это бронь, которой для платформы не существует:
 * человек идёт звонить оператору, а оператор её не ждёт.
 *
 * ── Третье расхождение той же природы (14.09) ─────────────────────────────
 *
 * Оно нашлось позже и держалось дольше: этот модуль не знал о МНОГОДНЕВНЫХ
 * турах. Длительность считал только путь оплаты (`app/api/bookings/tour`), он
 * же писал `end_date` и `duration_days`; здесь тур любой длины заводился как
 * однодневный.
 *
 * Цена — не косметическая. `v_tour_daily_occupancy` разворачивает бронь в дни
 * через `COALESCE(end_date, booking_date)`, то есть пустой `end_date` значит
 * «ровно один день». Группа с пятидневного тура занимала день выезда и
 * пропадала из остальных четырёх — для кабинета оператора, динамического
 * ценообразования, планера и гейта оплаченной брони дни 2..N были свободны.
 * Слепота была двусторонней: собственный счёт занятости искал по
 * `booking_date = $2` и не видел чужую многодневную бронь, накрывающую
 * запрошенный день серединой.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * Бронь заводит ЭТА функция и только она. Своя копия неизбежно разойдётся
 * снова — расхождение выше накопилось не за день. Правило длительности по той
 * же причине вынесено в `lib/bookings/duration.ts`: оно нужно обеим дверям, и
 * записанное дважды было бы двумя правилами.
 *
 * ── Чего функция НЕ делает ────────────────────────────────────────────────
 *
 * Не шлёт уведомлений, не пишет в аналитику, не выдаёт ссылок. У двух
 * вызывающих эти шаги разные (письмо и U-ON против сообщения в чат), и
 * сводить их сюда значило бы завести третью развилку внутри общего кода.
 */

import type { PoolClient } from 'pg';
import { bookingTotal } from '@/lib/tours/booking-total';
import { transaction } from '@/lib/database';
import { tourDurationDays, tourEndDate } from '@/lib/bookings/duration';

/** Причины отказа. Текст решает вызывающий: у чата и формы он разный. */
export type ReserveErrorCode =
  | 'NOT_FOUND'      // тура нет, снят с публикации или удалён
  | 'DATE_BLOCKED'   // оператор закрыл дату в календаре
  | 'MAX_EXCEEDED'   // запрошено больше, чем вмещает тур или дата
  | 'NO_SLOTS';      // мест на дату не осталось

export class ReserveError extends Error {
  constructor(public readonly code: ReserveErrorCode, message: string) {
    super(message);
    this.name = 'ReserveError';
  }
}

export interface ReserveInput {
  tourId: number;
  touristName: string;
  touristPhone: string;
  touristEmail?: string | null;
  participants: number;
  /** YYYY-MM-DD */
  date: string;
  specialRequests?: string | null;
  /** Откуда пришла бронь: 'website', 'kuzmich_tg', 'kuzmich_max'. */
  createdVia: string;
  /**
   * Аккаунт платформы, если он известен. У гостевой брони и у брони из чата
   * его может не быть вовсе — тогда null, и это честное «мы не знаем», а не
   * повод выдумать связь.
   */
  userId?: string | null;
  /** Произвольная метка канала (например, tg_chat_id) — идёт в metadata. */
  metadata?: Record<string, unknown> | null;
  /**
   * Согласие на обработку ПД — обстоятельства, а не булево: когда, откуда,
   * из какой формы и под какой версией формулировки (lib/legal/pd-consent).
   *
   * `null` и `undefined` означают «согласие НЕ ЗАФИКСИРОВАНО», а не «отказано».
   * Бронь приходит и из чата Кузьмича, где формы с галочкой нет вовсе; выдать
   * её молчание за согласие было бы худшим из исходов (§4.0). Третье
   * состояние хранится как NULL в четырёх колонках и видно запросом.
   */
  pdConsent?: import('@/lib/legal/pd-consent').PdConsentRecord | null;
}

export interface Reserved {
  bookingId: number;
  /** Ключ доступа к брони (миграция 943): им открывается подтверждение и PDF. */
  accessToken: string;
  totalPrice: number;
  operatorId: string;
  tourTitle: string;
}

/**
 * СТАТУС НОВОЙ БРОНИ — ОДИН.
 *
 * Кузьмич ставил `pending_payment`, веб-форма — `new`. Разные слова про одно
 * состояние: заявка создана, оператор её ещё не подтвердил. От статуса
 * зависит, увидит ли бронь Кузьмич, попадёт ли она в счёт занятости и
 * покажет ли страница кнопку оплаты, — то есть цена расхождения не
 * косметическая.
 *
 * Выбран `new`, а не `pending_payment`, ещё по одной причине. Крон
 * `abandoned-bookings` отменяет `pending_payment` через 24 часа без оплаты —
 * значит бронь из чата гасла сама, хотя оператор её уже получил и мог
 * договариваться по телефону. `pending_payment` означает «оплата начата», и
 * ставит его тот, кто её начинает: `POST /api/payments/tochka/qr` при выдаче
 * QR. Заведение брони — не начало оплаты.
 */
export const NEW_BOOKING_STATUS = 'new';

/**
 * Завести бронь: лок тура, календарь оператора, счёт занятости, вставка.
 *
 * Всё внутри ОДНОЙ транзакции с `FOR UPDATE` на строке тура — иначе два
 * одновременных туриста прочитают одну и ту же занятость и оба пройдут.
 */
export async function reserveBooking(input: ReserveInput): Promise<Reserved> {
  return transaction(async (client: PoolClient) => {
    const tourResult = await client.query<{
      operator_id: string;
      title: string;
      base_price: string;
      max_participants: number | null;
      multi_day_count: number | null;
      duration_hours: number | null;
      price_unit: string | null;
    }>(
      `SELECT ot.operator_id, ot.title, ot.base_price, ot.max_participants,
              ot.multi_day_count, ot.duration_hours, ot.price_unit
         FROM operator_tours ot
        WHERE ot.id = $1 AND ot.is_active = true AND ot.is_published = true
          AND ot.deleted_at IS NULL
        FOR UPDATE`,
      [input.tourId],
    );
    if (tourResult.rows.length === 0) {
      throw new ReserveError('NOT_FOUND', 'Тур не найден или больше не доступен.');
    }
    const tour = tourResult.rows[0]!;

    // Многодневный тур занимает ВСЕ свои дни, а не только день выезда. До
    // 14.09 этот модуль о многодневности не знал вовсе: `end_date` оставался
    // NULL, а `v_tour_daily_occupancy` понимает NULL как «ровно один день»
    // (`COALESCE(end_date, booking_date)`), и группа исчезала из дней 2..N.
    // Правило длительности — одно на обе двери, см. lib/bookings/duration.ts.
    const durationDays = tourDurationDays(tour);
    const endDate = tourEndDate(input.date, durationDays);

    /**
     * Календарь и занятость — ПО КАЖДОМУ дню диапазона, одним запросом.
     *
     * Календарь оператора опционален: нет строки на дату — дата свободна
     * (большинство операторов календарём не пользуются). Но явная блокировка
     * и лимит слотов обязаны уважаться на каждом дне, а не только на первом.
     *
     * Занятость берётся ИНТЕРВАЛОМ (`день BETWEEN booking_date И
     * COALESCE(end_date, booking_date)`), а не равенством дат. Прежнее
     * `booking_date = $2` не видело чужую многодневную бронь, накрывающую
     * запрошенную дату серединой, — слепота была двусторонней.
     *
     * Предикат статусов НЕ взят у `v_tour_daily_occupancy` намеренно. Вид
     * считает только `('new','confirmed')`, а здесь исключаются лишь
     * `('cancelled','rejected')` — то есть `pending_payment` (оплата уже
     * начата) место занимает. Перейти на предикат вида значило бы ОСЛАБИТЬ
     * проверку и продать место, за которое человек в эту минуту платит.
     * `deleted_at IS NULL` добавлен: снятая бронь места не держит.
     */
    const days = await client.query<{
      date: string;
      occupied: string;
      available_slots: number | null;
      is_cancelled: boolean | null;
    }>(
      `SELECT d.day::date AS date,
              COALESCE(occ.occupied, 0) AS occupied,
              ta.available_slots,
              ta.is_cancelled
         FROM generate_series($2::date, $3::date, '1 day') AS d(day)
         LEFT JOIN tour_availability ta
                ON ta.operator_tour_id = $1 AND ta.date = d.day::date
               AND ta.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(b.participants), 0) AS occupied
             FROM operator_bookings b
            WHERE b.operator_tour_id = $1
              AND b.booking_status NOT IN ('cancelled', 'rejected')
              AND b.deleted_at IS NULL
              AND d.day::date BETWEEN b.booking_date
                                  AND COALESCE(b.end_date, b.booking_date)
         ) occ ON true
        ORDER BY d.day`,
      [input.tourId, input.date, endDate],
    );

    for (const day of days.rows) {
      if (day.is_cancelled) {
        throw new ReserveError(
          'DATE_BLOCKED',
          durationDays > 1
            ? `Оператор закрыл бронирование на ${day.date} — эта дата входит в тур.`
            : 'Оператор закрыл бронирование на эту дату.',
        );
      }

      const slots = day.available_slots;
      const capacityCap: number | null = slots != null
        ? Math.min(tour.max_participants ?? slots, slots)
        : tour.max_participants;
      if (capacityCap == null) continue;   // потолка нет ни в туре, ни в календаре

      if (input.participants > capacityCap) {
        throw new ReserveError(
          'MAX_EXCEEDED',
          `Превышено максимальное число участников (максимум: ${capacityCap}).`,
        );
      }

      const alreadyBooked = parseInt(day.occupied, 10);
      if (alreadyBooked + input.participants > capacityCap) {
        const remaining = capacityCap - alreadyBooked;
        const where = durationDays > 1 ? ` на ${day.date}` : ' на эту дату';
        throw new ReserveError(
          'NO_SLOTS',
          remaining <= 0
            ? `Нет свободных мест${where}.`
            : `Недостаточно мест${where}. Доступно: ${remaining}, запрашивается: ${input.participants}.`,
        );
      }
    }

    // Единица цены решает, на что умножать (lib/tours/booking-total.ts):
    // тур «за группу» стоит base_price при любом числе участников.
    const totalPrice = bookingTotal({
      basePrice: Number(tour.base_price),
      priceUnit: tour.price_unit,
      participants: input.participants,
      duration: tour,
    });

    const inserted = await client.query<{ id: number; access_token: string }>(
      `INSERT INTO operator_bookings (
         operator_tour_id, tourist_name, tourist_email, tourist_phone,
         participants, booking_date, end_date, duration_days,
         special_requests, booking_status,
         base_total_price, final_price, created_via, user_id, metadata,
         pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
       RETURNING id, access_token::text AS access_token`,
      [
        input.tourId,
        input.touristName,
        input.touristEmail ?? null,
        input.touristPhone,
        input.participants,
        input.date,
        // Записывается ровно тот интервал, который только что проверен выше.
        // `end_date IS NULL` для всех читателей занятости означает «один
        // день», а не «неизвестно», — оставить его пустым у многодневного
        // тура значит отдать дни 2..N на повторную продажу.
        endDate,
        durationDays,
        input.specialRequests ?? '',
        NEW_BOOKING_STATUS,
        totalPrice,
        input.createdVia,
        input.userId ?? null,
        /**
         * user_id пишется ДВАЖДЫ: в колонку и в metadata, — и это не
         * небрежность, а вынужденная симметрия.
         *
         * Слово владельца 14.09: «бронь в любом случае должна сохраняться в
         * личном кабинете». Проверка показала дефект: ЛК туриста
         * (`/api/bookings`), отмена брони и вся админка ищут человека по
         * `metadata->>'user_id'`, а экспорт ПД и вся операторская сторона — по
         * колонке `user_id`. `app/api/bookings/tour` пишет обе (там это сделано
         * явно, с комментарием и ссылкой на PR #321), а сюда, при переезде
         * создания броней в общий модуль, переехала только колонка.
         *
         * Итог был такой: бронь, оставленная вошедшим человеком через форму
         * заявки или через Кузьмича, у оператора видна, а в личном кабинете
         * самого туриста — нет, и отменить её оттуда нельзя.
         *
         * Свести читателей к одному источнику — отдельная работа: у части
         * старых броней заполнено только одно поле, и переход на любое из них
         * в одиночку потерял бы чужую половину. Пока читатели разные, писать
         * надо обоим; реестр читателей заморожен сторожем
         * tests/unit/booking-owner-link.test.ts и может только сокращаться.
         *
         * Метка канала при этом не теряется: metadata вызывающего сливается с
         * привязкой, а не подменяется ею.
         */
        JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.userId ? { user_id: input.userId } : {}),
        }),
        // Согласие идёт В ТОЙ ЖЕ вставке, что бронь. Отдельный UPDATE после
        // дал бы окно, в котором бронь есть, а доказательства права её
        // хранить — нет; и окно это не теоретическое, а ровно такое же, как
        // у дедупа алертов 13.09.
        input.pdConsent?.at ?? null,
        input.pdConsent?.ip ?? null,
        input.pdConsent?.source ?? null,
        input.pdConsent?.version ?? null,
      ],
    );

    return {
      bookingId: inserted.rows[0]!.id,
      accessToken: inserted.rows[0]!.access_token,
      totalPrice,
      operatorId: tour.operator_id,
      tourTitle: tour.title,
    };
  });
}
