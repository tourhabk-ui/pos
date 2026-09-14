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
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * Бронь заводит ЭТА функция и только она. Своя копия неизбежно разойдётся
 * снова — расхождение выше накопилось не за день.
 *
 * ── Чего функция НЕ делает ────────────────────────────────────────────────
 *
 * Не шлёт уведомлений, не пишет в аналитику, не выдаёт ссылок. У двух
 * вызывающих эти шаги разные (письмо и U-ON против сообщения в чат), и
 * сводить их сюда значило бы завести третью развилку внутри общего кода.
 */

import type { PoolClient } from 'pg';
import { transaction } from '@/lib/database';

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
    }>(
      `SELECT ot.operator_id, ot.title, ot.base_price, ot.max_participants
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

    // Календарь оператора опционален: нет строки на дату — дата свободна
    // (большинство операторов календарём не пользуются). Но ЯВНАЯ блокировка
    // и лимит слотов обязаны уважаться обоими путями, а не только веб-формой.
    const calendar = await client.query<{ available_slots: number; is_cancelled: boolean }>(
      `SELECT available_slots, is_cancelled FROM tour_availability
        WHERE operator_tour_id = $1 AND date = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [input.tourId, input.date],
    );
    const calendarRow = calendar.rows[0] ?? null;
    if (calendarRow?.is_cancelled) {
      throw new ReserveError('DATE_BLOCKED', 'Оператор закрыл бронирование на эту дату.');
    }

    const capacityCap: number | null = calendarRow
      ? Math.min(tour.max_participants ?? calendarRow.available_slots, calendarRow.available_slots)
      : tour.max_participants;

    if (capacityCap != null && input.participants > capacityCap) {
      throw new ReserveError(
        'MAX_EXCEEDED',
        `Превышено максимальное число участников (максимум: ${capacityCap}).`,
      );
    }

    // Занятость считается ВНУТРИ транзакции: лок выше делает чтение верным.
    const booked = await client.query<{ already_booked: string }>(
      `SELECT COALESCE(SUM(participants), 0) AS already_booked
         FROM operator_bookings
        WHERE operator_tour_id = $1
          AND booking_date = $2
          AND booking_status NOT IN ('cancelled', 'rejected')`,
      [input.tourId, input.date],
    );
    const alreadyBooked = parseInt(booked.rows[0]!.already_booked, 10);

    if (capacityCap != null && alreadyBooked + input.participants > capacityCap) {
      const remaining = capacityCap - alreadyBooked;
      throw new ReserveError(
        'NO_SLOTS',
        remaining <= 0
          ? 'На выбранную дату нет свободных мест.'
          : `Недостаточно мест на эту дату. Доступно: ${remaining}, запрашивается: ${input.participants}.`,
      );
    }

    const totalPrice = Number(tour.base_price) * input.participants;

    const inserted = await client.query<{ id: number; access_token: string }>(
      `INSERT INTO operator_bookings (
         operator_tour_id, tourist_name, tourist_email, tourist_phone,
         participants, booking_date, special_requests, booking_status,
         base_total_price, final_price, created_via, user_id, metadata,
         pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
       RETURNING id, access_token::text AS access_token`,
      [
        input.tourId,
        input.touristName,
        input.touristEmail ?? null,
        input.touristPhone,
        input.participants,
        input.date,
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
