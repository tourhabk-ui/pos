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
 * (`lib/bookings/owner-status`), открытие дат — общее `openTourDates`.
 */
import { query } from '@/lib/database';

export interface OwnTour {
  id: string;
  title: string;
  slug: string | null;
  is_published: boolean;
  is_active: boolean;
  base_price: string | null;
  max_participants: number | null;
  season_start: string | null;
  season_end: string | null;
  /** Открытые будущие даты с местами — как их видит календарь тура. */
  open_dates: number;
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

/** Туры гида: опубликованные и черновики, с числом открытых будущих дат. */
export async function loadOwnTours(partnerId: string): Promise<OwnTour[]> {
  const { rows } = await query<OwnTour>(
    `SELECT t.id::text AS id, t.title, t.slug, COALESCE(t.is_published, FALSE) AS is_published,
            COALESCE(t.is_active, FALSE) AS is_active, t.base_price::text AS base_price,
            t.max_participants, t.season_start::text AS season_start, t.season_end::text AS season_end,
            (SELECT count(*)::int FROM tour_availability a
              WHERE a.operator_tour_id = t.id AND a.date >= CURRENT_DATE
                AND COALESCE(a.is_cancelled, FALSE) = FALSE AND a.deleted_at IS NULL
                AND a.available_slots > 0) AS open_dates
       FROM operator_tours t
      WHERE t.operator_id = $1::uuid AND t.deleted_at IS NULL
      ORDER BY COALESCE(t.is_published, FALSE) DESC, t.title`,
    [partnerId],
  );
  return rows;
}

/**
 * Брони по турам гида: все предстоящие и прошедшие за 30 дней — чтобы
 * отметить «завершена» или «не пришёл». Контакты туриста — ему, как продавцу
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
        AND b.booking_date >= CURRENT_DATE - 30
      ORDER BY (b.booking_status = 'new') DESC, b.booking_date ASC
      LIMIT 200`,
    [partnerId],
  );
  return rows;
}

/** Заявки, адресованные гиду (форма на его странице, заявка агента на тур). */
export async function loadOwnLeads(partnerId: string): Promise<OwnLead[]> {
  const { rows } = await query<OwnLead>(
    `SELECT l.id::text AS id, l.created_at::text AS created_at, l.status, l.name, l.phone, l.email,
            l.comment, l.desired_dates, l.group_size
       FROM leads l
      WHERE l.operator_id = $1::uuid
      ORDER BY l.created_at DESC
      LIMIT 100`,
    [partnerId],
  );
  return rows;
}
