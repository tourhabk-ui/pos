/**
 * «Свои туры» гида — туры, которые гид продаёт сам (`operator_tours.operator_id`
 * = его карточка; первый такой гид заведён миграцией 1338).
 *
 * До 28.10 у гида не было своих туров: тур продавал оператор, гид работал в
 * его команде (`partners.guide_operator_id`), и весь кабинет гида читает туры
 * и брони через оператора. Брони собственных туров гида при этом записывались,
 * но подтвердить их было нечем: кабинет броней и календарь открыты только
 * категории `operator` (lib/operators/team-access). Владелец 28.10 выбрал
 * «раздел в кабинете гида».
 *
 * Здесь — чтение раздела: туры гида, брони и заявки по ним. Кто вправе —
 * карточка вошедшего гида (`getGuidePartnerId`), а не параметр запроса.
 * Смена статуса брони — общее правило продавца тура
 * (`lib/bookings/owner-status`), заявки — `lib/leads/owner-lead-status`,
 * открытие дат — общее `openTourDates`.
 */
import { query } from '@/lib/database';
import { LEAD_WAITING_STATUSES } from '@/lib/leads/owner-lead-words';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publishBlockersSql } from '@/lib/guides/own-tour-publish';

export interface OwnTour {
  id: string;
  title: string;
  slug: string | null;
  is_published: boolean;
  is_active: boolean;
  base_price: string | null;
  /** Единица цены (`per_person` / `per_tour` / …) — для правки на сайте. */
  price_unit: string | null;
  max_participants: number | null;
  /** Тексты для правки на сайте: анонс и описание как записаны. */
  short_description: string | null;
  description: string | null;
  season_start: string | null;
  season_end: string | null;
  /** Открытые будущие даты с местами — как их видит календарь тура. */
  open_dates: number;
  /** Ответ шлюза каталога (`publicTourSql`) — видит ли тур турист. */
  on_storefront: boolean;
  /**
   * Чего не хватает до сайта — витринный гейт своего тура гида
   * (lib/guides/own-tour-publish, тот же SQL, что у кнопки «Опубликовать»).
   * Пусто — опубликовать можно.
   */
  blockers: string[];
}

export interface OwnBooking {
  id: string;
  tour_id: string;
  tour_title: string;
  booking_date: string;
  participants: number;
  booking_status: string;
  tourist_name: string | null;
  tourist_phone: string | null;
  tourist_email: string | null;
  special_requests: string | null;
  created_at: string;
}

export interface OwnLead {
  id: string;
  created_at: string;
  status: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  desired_dates: string | null;
  group_size: number | null;
}

/** Туры гида: опубликованные и черновики, с числом открытых будущих дат и тем, чего не хватает до сайта. */
export async function loadOwnTours(partnerId: string): Promise<OwnTour[]> {
  const { rows } = await query<OwnTour>(
    `SELECT ot.id::text AS id, ot.title, ot.slug, COALESCE(ot.is_published, FALSE) AS is_published,
            COALESCE(ot.is_active, FALSE) AS is_active, ot.base_price::text AS base_price, ot.price_unit,
            ot.max_participants, ot.short_description, ot.description, ot.season_start::text AS season_start, ot.season_end::text AS season_end,
            (SELECT count(*)::int FROM tour_availability a
              WHERE a.operator_tour_id = ot.id AND a.date >= CURRENT_DATE
                AND COALESCE(a.is_cancelled, FALSE) = FALSE AND a.deleted_at IS NULL
                AND a.available_slots > 0) AS open_dates,
            ${publicTourSql('ot')} AS on_storefront,
            ${publishBlockersSql()} AS blockers
       FROM operator_tours ot
       JOIN partners p ON p.id = ot.operator_id
      WHERE ot.operator_id = $1::uuid AND ot.deleted_at IS NULL
      ORDER BY COALESCE(ot.is_published, FALSE) DESC, ot.title`,
    [partnerId],
  );
  return rows;
}

/**
 * Брони по турам гида: все предстоящие и прошедшие за 30 дней — чтобы
 * отметить «завершена» или «не пришёл». Неподтверждённая («new») — любой
 * давности: «Входящие» гида (lib/crm/inbox-sql) держат её до ответа и ведут
 * сюда, и здесь она обязана быть. Контакты туриста — ему, как продавцу
 * тура: тот же состав, что видит оператор в своём кабинете.
 */
export async function loadOwnBookings(partnerId: string): Promise<OwnBooking[]> {
  const { rows } = await query<OwnBooking>(
    `SELECT b.id::text AS id, t.id::text AS tour_id, t.title AS tour_title,
            b.booking_date::text AS booking_date, b.participants, b.booking_status,
            b.tourist_name, b.tourist_phone, b.tourist_email, b.special_requests,
            b.created_at::text AS created_at
       FROM operator_bookings b
       JOIN operator_tours t ON t.id = b.operator_tour_id
      WHERE t.operator_id = $1::uuid AND b.deleted_at IS NULL
        AND (b.booking_date >= CURRENT_DATE - 30 OR b.booking_status = 'new')
      ORDER BY (b.booking_status = 'new') DESC, b.booking_date ASC
      LIMIT 200`,
    [partnerId],
  );
  return rows;
}

/**
 * Заявки, адресованные гиду (форма на его странице, заявка агента на тур), —
 * тот же отбор, что у «Входящих» (lib/crm/inbox-sql, вид `lead`): своя проба
 * владельца (`is_self`) — не заявка. Ждущие ответа — первыми и любой
 * давности: ссылка «Входящих» ведёт сюда, и каждая ждущая обязана тут быть.
 * Ответ — `PATCH /api/guide/own/leads/[id]` (lib/leads/owner-lead-status).
 */
export async function loadOwnLeads(partnerId: string): Promise<OwnLead[]> {
  const { rows } = await query<OwnLead>(
    `SELECT l.id::text AS id, l.created_at::text AS created_at, l.status, l.name, l.phone, l.email,
            l.comment, l.desired_dates, l.group_size
       FROM leads l
      WHERE l.operator_id = $1::uuid AND l.is_self = FALSE
      ORDER BY (l.status = ANY($2::text[])) DESC, l.created_at DESC
      LIMIT 100`,
    [partnerId, [...LEAD_WAITING_STATUSES]],
  );
  return rows;
}
