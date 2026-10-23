/**
 * Место, где заводится бронь тура — из веб-формы, из чата Кузьмича и из
 * кабинета агента (бронь за клиента).
 *
 * С 26.09 это снова ЕДИНСТВЕННАЯ дверь. До этого `app/api/bookings/tour`
 * делал свой `INSERT INTO operator_bookings` мимо этой функции и вдобавок
 * списывал деньги картой ДО подтверждения оператором; роут удалён, его
 * модалка (`TourPaymentModal`) бронирует через ту же форму, что карточка тура.
 * Вместе с ним сюда переехала атрибуция агентской ссылки: код ссылки
 * разрешается здесь, в транзакции брони, и пишет `referral_link_id` и
 * `agent_user_id` (миграция 1022) — «чья продажа».
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
 * ── Четвёртое расхождение: правка 14.09 легла в одну дверь из трёх (15.10) ──
 *
 * Аудит 15.10 (находка P2-01) нашёл, что «единственная» здесь значило
 * «единственная для туриста и агента». Строку `operator_bookings` писали ещё
 * три живых места, и правило многодневности 14.09 до них не дошло:
 *
 *   ручная бронь оператора (`/api/hub/operator/bookings`) — без `end_date`
 *     и `duration_days`: пятидневная группа, заведённая по звонку, занимала
 *     для всех поверхностей занятости только день выезда;
 *   OCTO-холд реселлера (`lib/octo/service.ts`) — то же, плюс свой счёт мест
 *     равенством `booking_date = $2` и только при строке календаря на день
 *     выезда, под `SKIP LOCKED`, который при гонке пропускал проверку вовсе;
 *   `/api/tours/[id]/book` — `end_date = booking_date`, `duration_days = 1`
 *     константами для тура любой длины, детская скидка 50% из головы. Роут
 *     не звал никто — удалён.
 *
 * Теперь слоёв два, и у каждого одно место:
 *
 *   ВСТАВКА — `insertBookingRow`: единственный `INSERT INTO operator_bookings`
 *     в приложении. `end_date` и `duration_days` дверь не передаёт вовсе —
 *     вставка выводит их сама из длительности тура, забыть их нельзя;
 *   ГЕЙТ — `readTourDays` + `assertDaysOpen`: календарь оператора и
 *     занятость по КАЖДОМУ дню диапазона интервалом.
 *
 * Двери: `reserveBooking` (форма, Кузьмич, агент, запрос мест) — гейт и
 * вставка; OCTO — гейт и вставка, но цена и холд свои: это внешний контракт;
 * ручная бронь оператора — только вставка. Гейта у неё нет намеренно: это
 * запись того, о чём оператор уже договорился сам, и отказать ему в записи
 * значило бы потерять бронь, которая всё равно состоится.
 *
 * Перепись писателей — по коду, не по списку имён:
 * `tests/unit/booking-single-writer.test.ts`.
 *
 * ── Чего функция НЕ делает ────────────────────────────────────────────────
 *
 * Не шлёт уведомлений и не выдаёт ссылок. У вызывающих эти шаги разные
 * (письмо и U-ON, сообщение в чат, ссылка агенту), и сводить их сюда значило
 * бы завести развилку внутри общего кода. Единственная «аналитика» здесь —
 * журнал агентской ссылки (событие 'booking' и счётчик), и то после коммита:
 * она принадлежит атрибуции, которая решается именно здесь.
 */

import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';
import type { PoolClient } from 'pg';
import { honestTourPrice } from '@/lib/tours/honest-price';
import { PriceTierMissError } from '@/lib/tours/price-tiers';
import { transaction } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { tourDurationDays, tourEndDate, type TourDurationSource } from '@/lib/bookings/duration';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import { requestWindow, dateInWindow, outOfSeasonText } from '@/lib/tours/request-window';
import { kamchatkaToday } from '@/lib/seat-requests/core';

/** Причины отказа. Текст решает вызывающий: у чата и формы он разный. */
export type ReserveErrorCode =
  | 'NOT_FOUND'      // тура нет, снят с публикации или удалён
  | 'DATE_BLOCKED'   // оператор закрыл дату в календаре
  | 'MAX_EXCEEDED'   // запрошено больше, чем вмещает тур или дата
  | 'NO_SLOTS'       // мест на дату не осталось
  | 'OUT_OF_SEASON'  // даты нет в календаре, и она вне записанного сезона тура
  | 'PRICE_UNKNOWN'; // размер группы вне ступеней цены: суммы нет, её называет оператор

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
  /**
   * Код агентской ссылки (`KH-AGT-...`), с которым турист пришёл. Живость
   * кода решается ЗДЕСЬ, внутри транзакции брони: активная и не истёкшая
   * ссылка даёт `referral_link_id` и `agent_user_id` (владелец ссылки).
   *
   * Плохой код — не причина отказать туристу: бронь заводится без
   * атрибуции, а почему — пишется в лог. Турист не виноват в том, что
   * ссылка погашена, и починить это не может.
   */
  referralCode?: string | null;
  /**
   * Агент, оформивший бронь ЗА СВОЕГО КЛИЕНТА (`users.id` с ролью agent).
   * Сильнее кода ссылки: продажу сделал он сам, и чужой код в памяти
   * браузера её не переписывает. Туристу аккаунт агента НЕ приписывается —
   * `user_id` остаётся тем, что передал вызывающий (обычно null).
   */
  agentUserId?: string | null;
}

export interface Reserved {
  bookingId: number;
  /** Ключ доступа к брони (миграция 943): им открывается подтверждение и PDF. */
  accessToken: string;
  totalPrice: number;
  operatorId: string;
  tourTitle: string;
  /** Чья продажа: `operator_bookings.agent_user_id`. null — продажа без агента. */
  agentUserId: string | null;
  /** Ссылка, по которой пришёл турист; null — без ссылки или код не принят. */
  referralLinkId: string | null;
}

/** Почему код ссылки не дал атрибуции — для лога, не для туриста. */
function describeRejectedCode(code: string): string {
  return `код ${code} не найден, выключен или истёк — бронь без атрибуции`;
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

/** То, у чего есть `query`: клиент транзакции брони. */
type BookingExecutor = Pick<PoolClient, 'query'>;

/**
 * Длительность тура из строки базы. `integer` приходит числом, `numeric` —
 * строкой, и сравнение строки с числом в правиле длительности было бы
 * случайностью приведения, а не правилом.
 */
export function tourDurationOf(row: { multi_day_count: unknown; duration_hours: unknown }): TourDurationSource {
  const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
  return { multi_day_count: num(row.multi_day_count), duration_hours: num(row.duration_hours) };
}

/** День диапазона брони: календарь оператора и занятость на этот день. */
export interface TourDay {
  date: string;
  occupied: string;
  available_slots: number | null;
  is_cancelled: boolean | null;
}

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
 *
 * Вызывать — клиентом транзакции, взявшей `FOR UPDATE` на строке тура:
 * иначе два одновременных запроса прочитают одну и ту же занятость.
 *
 * `excludeBookingId` — бронь, которую ПЕРЕНОСЯТ (аудит 15.10,
 * RESCHEDULE-GATE): её собственные места не занятость для её же новых дней,
 * иначе перенос на соседний день отказал бы из-за самой переносимой группы.
 * Новая бронь его не передаёт — ей исключать нечего.
 */
export async function readTourDays(
  exec: BookingExecutor,
  tourId: number | string,
  startDate: string,
  endDate: string,
  opts: { excludeBookingId?: number | string } = {},
): Promise<TourDay[]> {
  // Условие исключения — только когда исключать есть кого: запрос новой
  // брони (форма, Кузьмич, агент, OCTO) остаётся прежним до знака.
  const exclude = opts.excludeBookingId ?? null;
  const params: Array<number | string> = [tourId, startDate, endDate];
  if (exclude != null) params.push(exclude);
  const days = await exec.query<TourDay>(
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
            ${exclude != null ? 'AND b.id <> $4::bigint' : ''}
            AND d.day::date BETWEEN b.booking_date
                                AND COALESCE(b.end_date, b.booking_date)
       ) occ ON true
      ORDER BY d.day`,
    params,
  );
  return days.rows;
}

/**
 * Каждый день диапазона открыт и вмещает группу — иначе ReserveError с
 * кодом причины. Чистая функция над ответом `readTourDays`: решение одно на
 * все двери, слова отказа каждая дверь выбирает свои.
 */
export function assertDaysOpen(
  days: TourDay[],
  opts: { participants: number; maxParticipants: number | null; durationDays: number },
): void {
  for (const day of days) {
    if (day.is_cancelled) {
      throw new ReserveError(
        'DATE_BLOCKED',
        opts.durationDays > 1
          ? `Оператор закрыл приём заявок на ${day.date} — эта дата входит в тур.`
          : 'Оператор закрыл приём заявок на эту дату.',
      );
    }

    const slots = day.available_slots;
    const capacityCap: number | null = slots != null
      ? Math.min(opts.maxParticipants ?? slots, slots)
      : opts.maxParticipants;
    if (capacityCap == null) continue;   // потолка нет ни в туре, ни в календаре

    if (opts.participants > capacityCap) {
      throw new ReserveError(
        'MAX_EXCEEDED',
        `Превышено максимальное число участников (максимум: ${capacityCap}).`,
      );
    }

    const alreadyBooked = parseInt(day.occupied, 10);
    if (alreadyBooked + opts.participants > capacityCap) {
      const remaining = capacityCap - alreadyBooked;
      const where = opts.durationDays > 1 ? ` на ${day.date}` : ' на эту дату';
      throw new ReserveError(
        'NO_SLOTS',
        remaining <= 0
          ? `Нет свободных мест${where}.`
          : `Недостаточно мест${where}. Доступно: ${remaining}, запрашивается: ${opts.participants}.`,
      );
    }
  }
}

/**
 * Колонки строки брони, которые дверь передаёт в `insertBookingRow`. Имена —
 * как в базе.
 *
 * `end_date` и `duration_days` здесь НЕТ намеренно (аудит 15.10, P2-01): их
 * выводит сама вставка из длительности тура. Пока их передавала дверь, две
 * двери из трёх их не передавали.
 *
 * Поле, которого дверь не передала (`undefined`), в INSERT не упоминается
 * вовсе — работает умолчание базы. `null` — записанное «нет».
 */
export interface BookingRowValues {
  operator_tour_id: number | string;
  /** YYYY-MM-DD — день выезда. */
  booking_date: string;
  participants: number;
  /**
   * С каким словом бронь РОЖДАЕТСЯ. Других у новой брони нет: остальные
   * статусы ставит смена состояния, а не вставка, — и слово, которого не
   * знают читатели занятости и кабинета, через эту дверь не войдёт.
   */
  booking_status: 'new' | 'confirmed';
  base_total_price: number;
  final_price: number;
  created_via: string;
  tourist_name?: string | null;
  tourist_email?: string | null;
  tourist_phone?: string | null;
  adult_count?: number | null;
  child_count?: number | null;
  special_requests?: string | null;
  payment_status?: 'pending' | 'paid';
  payment_method?: string | null;
  discount_percent?: number | null;
  discount_reason?: string | null;
  user_id?: string | null;
  /** JSON-строка, пишется в jsonb. */
  metadata?: string;
  pd_consent_at?: PdConsentRecord['at'] | null;
  pd_consent_ip?: PdConsentRecord['ip'] | null;
  pd_consent_source?: PdConsentRecord['source'] | null;
  pd_consent_version?: PdConsentRecord['version'] | null;
  referral_link_id?: string | null;
  agent_user_id?: string | null;
  lead_id?: string;
  octo_api_key_id?: string;
  option_id?: string;
  hold_expires_at?: string;
  availability_id?: string;
  reseller_reference?: string | null;
}

/** Порядок колонок во вставке. Сверяется со схемой сторожем booking-single-writer. */
export const BOOKING_ROW_COLUMNS = [
  'operator_tour_id', 'tourist_name', 'tourist_email', 'tourist_phone',
  'participants', 'adult_count', 'child_count',
  'booking_date', 'end_date', 'duration_days',
  'special_requests', 'booking_status', 'payment_status', 'payment_method',
  'base_total_price', 'final_price', 'discount_percent', 'discount_reason',
  'created_via', 'user_id', 'metadata',
  'pd_consent_at', 'pd_consent_ip', 'pd_consent_source', 'pd_consent_version',
  'referral_link_id', 'agent_user_id', 'lead_id',
  'octo_api_key_id', 'option_id', 'hold_expires_at', 'availability_id', 'reseller_reference',
] as const satisfies ReadonlyArray<keyof BookingRowValues | 'end_date' | 'duration_days'>;

const COLUMN_CAST: Readonly<Partial<Record<(typeof BOOKING_ROW_COLUMNS)[number], string>>> = {
  metadata: '::jsonb',
  lead_id: '::uuid',
};

/** Что возвращает вставка. Каждая дверь берёт своё. */
export interface InsertedBooking {
  id: number;
  /** Ключ доступа к брони (миграция 943). */
  access_token: string;
  /** Идентификатор брони для OCTO; умолчание базы есть у любой строки. */
  octo_uuid: string;
  booking_status: string;
  booking_date: string;
  end_date: string;
  duration_days: number;
  participants: number;
  final_price: string | null;
  created_at: Date | string;
}

/**
 * ЕДИНСТВЕННАЯ вставка строки брони тура в приложении.
 *
 * `end_date` и `duration_days` выводятся здесь из длительности тура
 * (lib/bookings/duration.ts) — тем же правилом, каким гейт выше считает
 * диапазон дней. Вставка не проверяет ни календарь, ни места: это делает
 * вызывающий гейтом (`readTourDays` + `assertDaysOpen`) ТЕМ ЖЕ клиентом
 * транзакции до вставки — либо сознательно не делает (ручная бронь
 * оператора, см. шапку файла).
 */
export async function insertBookingRow(
  exec: BookingExecutor,
  row: BookingRowValues,
  duration: TourDurationSource,
): Promise<InsertedBooking> {
  const known: ReadonlyArray<string> = BOOKING_ROW_COLUMNS;
  for (const key of Object.keys(row)) {
    // Колонка вне списка молча не записалась бы — это ошибка кода, а не данных.
    if (!known.includes(key) || key === 'end_date' || key === 'duration_days') {
      throw new Error(`insertBookingRow: колонка ${key} не входит в строку брони`);
    }
  }

  const durationDays = tourDurationDays(duration);
  const values: Record<string, unknown> = {
    ...row,
    // `end_date IS NULL` все читатели занятости понимают как «ровно один
    // день», а не «неизвестно», — оставить его пустым у многодневного тура
    // значит отдать дни 2..N на повторную продажу.
    end_date: tourEndDate(row.booking_date, durationDays),
    duration_days: durationDays,
  };
  const columns = BOOKING_ROW_COLUMNS.filter((c) => values[c] !== undefined);

  const inserted = await exec.query<InsertedBooking>(
    `INSERT INTO operator_bookings (${columns.join(', ')})
     VALUES (${columns.map((c, i) => `$${i + 1}${COLUMN_CAST[c] ?? ''}`).join(', ')})
     RETURNING id, access_token::text AS access_token, octo_uuid::text AS octo_uuid,
               booking_status, booking_date::text AS booking_date,
               end_date::text AS end_date, duration_days, participants,
               final_price, created_at`,
    columns.map((c) => values[c]),
  );
  const created = inserted.rows[0];
  if (!created) throw new Error('insertBookingRow: вставка брони не вернула строку');
  return created;
}

/**
 * Завести бронь: лок тура, календарь оператора, счёт занятости, вставка.
 *
 * Всё внутри ОДНОЙ транзакции с `FOR UPDATE` на строке тура — иначе два
 * одновременных туриста прочитают одну и ту же занятость и оба пройдут.
 */
export async function reserveBooking(input: ReserveInput): Promise<Reserved> {
  const reserved = await transaction(async (client: PoolClient): Promise<Reserved> => {
    const tourResult = await client.query<{
      operator_id: string;
      title: string;
      base_price: string;
      max_participants: number | null;
      multi_day_count: number | null;
      duration_hours: number | null;
      price_unit: string | null;
      duration_type: string | null;
      season_start: string | null;
      season_end: string | null;
    }>(
      `SELECT ot.operator_id, ot.title, ot.base_price, ot.max_participants,
              ot.multi_day_count, ot.duration_hours, ot.price_unit,
              ot.duration_type, ot.season_start::text, ot.season_end::text
         FROM operator_tours ot
        WHERE ot.id = $1 AND ot.is_active = true
          AND (ot.is_published = true OR ot.operator_id = ANY($2::uuid[]))
          AND ot.deleted_at IS NULL
        FOR UPDATE`,
      [input.tourId, TEST_STAND_PARTNER_IDS],
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

    // Календарь и занятость по каждому дню диапазона — общим гейтом, тем же,
    // что у OCTO-двери (readTourDays: почему интервал и почему такой предикат
    // статусов).
    const days = await readTourDays(client, input.tourId, input.date, endDate);

    // Дата выезда без строки календаря — только по сезону тура (#2244,
    // #2245, lib/tours/request-window). Строка календаря — слово оператора и
    // сильнее сезона: открытую им дату правило не трогает.
    const startDay = days[0];
    if (!startDay || (startDay.available_slots == null && startDay.is_cancelled == null)) {
      const window = requestWindow(tour, kamchatkaToday());
      if (window.kind === 'season' && !dateInWindow(window, input.date)) {
        throw new ReserveError('OUT_OF_SEASON', outOfSeasonText(window, input.date));
      }
    }

    assertDaysOpen(days, {
      participants: input.participants,
      maxParticipants: tour.max_participants,
      durationDays,
    });

    /**
     * Цена брони — та же, что показана туристу (lib/tours/honest-price.ts).
     *
     * До 27.09 здесь стоял `bookingTotal(base_price × участники)` мимо правил
     * `tour_pricing_rules`. Пока цену мимо правил показывали ВСЕ поверхности,
     * расхождения не было; в тот день владелец попросил показать скидки, и
     * первым делом её обязана считать бронь — иначе человек увидел бы
     * «−15%, последние места» на карточке, а в заявке и в письме получил
     * полную сумму.
     *
     * Правила читаются КЛИЕНТОМ ЭТОЙ ЖЕ транзакции: выше взят `FOR UPDATE` на
     * строке тура, и занятость даты, прочитанная вторым соединением, не
     * увидела бы ни лока, ни только что вставленных строк.
     *
     * Цену от клиента этот модуль не принимает и никогда не принимал — в
     * `ReserveInput` такого поля нет. Считает сервер.
     */
    // Группа вне ступеней цены: бронь без суммы не заводится. Подставить
    // базовую цену значило бы записать в заявку и в письмо оператору сумму,
    // которой он не называл (#2246).
    let price: Awaited<ReturnType<typeof honestTourPrice>>;
    try {
      price = await honestTourPrice({
        tourId: input.tourId,
        tourDate: input.date,
        baseUnitPrice: Number(tour.base_price),
        priceUnit: tour.price_unit,
        participants: input.participants,
        duration: tour,
        exec: client,
      });
    } catch (err) {
      if (err instanceof PriceTierMissError) throw new ReserveError('PRICE_UNKNOWN', err.message);
      throw err;
    }
    const totalPrice = price.total;

    /**
     * Чья продажа. Бронь за клиента агента — его, без вопросов. Иначе —
     * владелец активной ссылки, если турист пришёл с её кодом. Код
     * разрешается ВНУТРИ транзакции брони: ссылка, погашенная между кликом и
     * бронью, атрибуции не даёт.
     */
    let agentUserId: string | null = input.agentUserId ?? null;
    let referralLinkId: string | null = null;
    const code = input.referralCode?.trim().toUpperCase() || null;
    if (!agentUserId && code) {
      const link = await client.query<{ id: string; agent_id: string }>(
        `SELECT id, agent_id
           FROM agent_referral_links
          WHERE code = $1 AND is_active = true
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1`,
        [code],
      );
      const row = link.rows[0];
      if (row) {
        referralLinkId = row.id;
        agentUserId = row.agent_id;
      } else {
        console.warn('[reserve] ' + describeRejectedCode(code));
      }
    }

    // Строка брони — общей вставкой (insertBookingRow): `end_date` и
    // `duration_days` она выводит из того же тура тем же правилом, каким
    // выше посчитан проверенный диапазон, — записывается ровно он.
    const inserted = await insertBookingRow(client, {
      operator_tour_id: input.tourId,
      tourist_name: input.touristName,
      tourist_email: input.touristEmail ?? null,
      tourist_phone: input.touristPhone,
      participants: input.participants,
      booking_date: input.date,
      special_requests: input.specialRequests ?? '',
      booking_status: NEW_BOOKING_STATUS,
      // Итог по цене оператора и итог после правил — РАЗНЫЕ колонки. До
      // 27.09 в обе шло одно значение ($11 дважды), и разбор брони не мог
      // ответить, была ли скидка.
      base_total_price: price.baseTotal,
      final_price: totalPrice,
      /**
       * Скидка записывается только когда она скидка. Надбавка (`> 0`) в
       * колонку с именем `discount_percent` не пишется — иначе «скидка
       * −10%» означала бы подорожание, и следующий читатель это перепутает.
       * Причина при этом пишется всегда: она называет и надбавку.
       */
      discount_percent: price.changePercent !== null && price.changePercent < 0 ? Math.abs(price.changePercent) : null,
      discount_reason: price.label,
      created_via: input.createdVia,
      user_id: input.userId ?? null,
      /**
       * user_id пишется ДВАЖДЫ: в колонку и в metadata, — и это не
       * небрежность, а вынужденная симметрия.
       *
       * Слово владельца 14.09: «бронь в любом случае должна сохраняться в
       * личном кабинете». Проверка показала дефект: ЛК туриста
       * (`/api/bookings`), отмена брони и вся админка ищут человека по
       * `metadata->>'user_id'`, а экспорт ПД и вся операторская сторона — по
       * колонке `user_id`. `app/api/bookings/tour` (удалён 26.09) писал обе (там это было сделано
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
      metadata: JSON.stringify({
        ...(input.metadata ?? {}),
        ...(input.userId ? { user_id: input.userId } : {}),
      }),
      // Согласие идёт В ТОЙ ЖЕ вставке, что бронь. Отдельный UPDATE после
      // дал бы окно, в котором бронь есть, а доказательства права её
      // хранить — нет; и окно это не теоретическое, а ровно такое же, как
      // у дедупа алертов 13.09.
      pd_consent_at: input.pdConsent?.at ?? null,
      pd_consent_ip: input.pdConsent?.ip ?? null,
      pd_consent_source: input.pdConsent?.source ?? null,
      pd_consent_version: input.pdConsent?.version ?? null,
      referral_link_id: referralLinkId,
      agent_user_id: agentUserId,
    }, tour);

    return {
      bookingId: inserted.id,
      accessToken: inserted.access_token,
      totalPrice,
      operatorId: tour.operator_id,
      tourTitle: tour.title,
      agentUserId,
      referralLinkId,
    };
  });

  // Журнал ссылки и её счётчик — ПОСЛЕ коммита: источник истины для продажи
  // уже записан в самой брони (referral_link_id, agent_user_id), а это
  // аналитика кабинета. Отказ не валит бронь, но и не глушится (§4.0).
  if (reserved.referralLinkId) {
    try {
      await pool.query(
        `INSERT INTO agent_referral_events (link_id, event_type, booking_id)
         VALUES ($1, 'booking', $2)`,
        [reserved.referralLinkId, reserved.bookingId],
      );
      await pool.query(
        `UPDATE agent_referral_links SET conversions = COALESCE(conversions, 0) + 1 WHERE id = $1`,
        [reserved.referralLinkId],
      );
    } catch (err) {
      const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
      console.error(
        `[reserve] событие брони по ссылке не записано (бронь ${reserved.bookingId}), SQLSTATE ${sqlstate}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Клиент оператора в CRM (#2325) — после коммита и молча для брони:
  // отказ пишется в лог, пропуск подберёт задел crm-contacts-sync.
  await linkContactQuietly('operator_booking', reserved.bookingId);

  return reserved;
}
