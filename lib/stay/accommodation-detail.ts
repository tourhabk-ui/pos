/**
 * Публичная карточка объекта размещения — один загрузчик для страницы
 * /accommodations/[id] и для GET /api/accommodations/[id].
 *
 * До 01.10 страница была оболочкой: всё содержимое клиент тянул из API уже в
 * браузере, и поисковик видел 19 слов без заголовка (аудит vedarai.ru 01.10 —
 * «пустая карточка жилья» в карте сайта). Теперь сервер отдаёт карточку
 * целиком, а API читает тот же загрузчик: контракт у двух дорог один.
 *
 * Витрина — только одобренные администратором и не скрытые владельцем
 * объекты (миграция 1027, publicAccommodationSql). null — объекта нет или он
 * не на витрине; база не ответила — исключение, решает вызывающий.
 */
import { query } from '@/lib/database';
import { publicReviewerName } from '@/lib/reviews/public-name';
import { publicRating } from '@/lib/reviews/public-rating';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { normalizeContactPhone, NUMBER_MESSENGERS, type NumberMessenger } from '@/lib/stay/contact-phone';
import { STAY_PHOTO_ORDER_SQL } from '@/lib/stay/photo-order';

export interface AccommodationRoom {
  id: string;
  name: string;
  roomType: string;
  description: string | null;
  sizeSqm: number | null;
  maxGuests: number;
  bedsConfiguration: unknown[];
  amenities: unknown[];
  view: unknown;
  availableRooms: unknown;
  pricePerNight: number;
}

export interface AccommodationReview {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  user: { name: string | null };
  /** Ответ хозяина под отзывом (миграция 1208); NULL — не отвечал. */
  ownerReply: string | null;
}

export interface AccommodationSimilar {
  id: string;
  name: string;
  type: string;
  description: string | null;
  address: string;
  /** null — цену не называли. */
  pricePerNight: number | null;
  currency: string;
  /** null — объект никто не оценивал (§4.0), а не «нуль звёзд». */
  rating: number | null;
  reviewCount: number;
  image: string | null;
}

export interface AccommodationDetailData {
  id: string;
  name: string;
  type: string;
  description: string | null;
  shortDescription: string | null;
  address: string;
  coordinates: unknown;
  locationZone: string | null;
  starRating: number | null;
  totalRooms: unknown;
  checkInTime: string | null;
  checkOutTime: string | null;
  /** from: null — цену не называли (объект с бронью на своём сайте). */
  pricePerNight: { from: number | null; to: number | null; currency: string };
  amenities: string[];
  languages: unknown[];
  /** Бронь на сайте самого объекта (миграция 1109); null — нет. */
  externalBookingUrl: string | null;
  /**
   * Телефон самого объекта для связи (миграция 1179), в виде «+7XXXXXXXXXX».
   * null — не записан. Это не телефон партнёра из аккаунта (`partner.phone`).
   */
  contactPhone: string | null;
  /** На каких мессенджерах заведён этот номер (миграция 1181); [] — не записано. */
  contactMessengers: NumberMessenger[];
  /** null — объект никто не оценивал (§4.0), а не «нуль звёзд». */
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
  partner: { name: string | null; email: string | null; phone: string | null };
  images: { url: string; alt: string | null; mime_type?: string | null }[];
  rooms: AccommodationRoom[];
  reviews: AccommodationReview[];
  similar: AccommodationSimilar[];
  createdAt: string | null;
  updatedAt: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Дата строкой: страница и API отдают одно и то же. */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function loadAccommodationDetail(id: string): Promise<AccommodationDetailData | null> {
  // Не-uuid — «такого объекта нет», а не 500 от 22P02.
  if (!UUID_RE.test(id)) return null;

  // Получаем основную информацию. Витрина — только одобренные
  // администратором и не скрытые владельцем (миграция 1027).
  const accommodationResult = await query<{
    id: string; name: string; type: string; description: string | null; short_description: string | null;
    address: string; coordinates: unknown; location_zone: string | null; star_rating: unknown;
    total_rooms: unknown; check_in_time: unknown; check_out_time: unknown;
    price_per_night_from: string | null; price_per_night_to: string | null; currency: string;
    external_booking_url: string | null; contact_phone: string | null; contact_messengers: unknown;
    amenities: unknown; languages: unknown; rating: string | null; review_count: unknown;
    is_verified: boolean; partner_name: string | null; partner_email: string | null;
    partner_phone: string | null; images: unknown; created_at: unknown; updated_at: unknown;
  }>(
    `SELECT
      a.*,
      p.name as partner_name,
      p.contact->>'email' as partner_email,
      p.contact->>'phone' as partner_phone,
      (
        SELECT json_agg(json_build_object(
          'url', ast.url,
          'alt', ast.alt,
          'mime_type', ast.mime_type
        ) ORDER BY ${STAY_PHOTO_ORDER_SQL})
        FROM accommodation_assets aa
        JOIN assets ast ON aa.asset_id = ast.id
        WHERE aa.accommodation_id = a.id
      ) as images
    FROM accommodations a
    LEFT JOIN partners p ON a.partner_id = p.id
    WHERE a.id = $1 AND ${publicAccommodationSql('a')}`,
    [id]
  );

  const accommodation = accommodationResult.rows[0];
  if (!accommodation) return null;

  // Получаем список номеров
  const roomsResult = await query<{
    id: string; name: string; room_type: string; description: string | null; size_sqm: unknown;
    max_guests: unknown; beds_configuration: unknown; amenities: unknown; view: unknown;
    available_rooms: unknown; price_per_night: string; is_active: boolean;
  }>(
    `SELECT
      id,
      name,
      room_type,
      description,
      size_sqm,
      max_guests,
      beds_configuration,
      amenities,
      view,
      available_rooms,
      price_per_night,
      is_active
    FROM accommodation_rooms
    WHERE accommodation_id = $1 AND is_active = true
    ORDER BY price_per_night ASC`,
    [id]
  );

  // Получаем отзывы (последние 10)
  const reviewsResult = await query<{
    id: string; rating: string; comment: string | null; created_at: unknown;
    user_name: string | null; owner_reply: string | null;
  }>(
    `SELECT
      r.id,
      r.overall_rating as rating,
      r.comment,
      r.created_at,
      r.owner_reply,
      u.name as user_name
    FROM accommodation_reviews r
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.accommodation_id = $1 AND r.is_visible = true
    ORDER BY r.created_at DESC
    LIMIT 10`,
    [id]
  );

  // Получаем похожие объекты (того же типа, в той же зоне)
  const similarResult = await query<{
    id: string; name: string; type: string; short_description: string | null; address: string;
    price_per_night_from: string | null; currency: string; rating: string | null; review_count: unknown;
    images: Array<{ url: string }> | null;
  }>(
    `SELECT
      a.id,
      a.name,
      a.type,
      a.short_description,
      a.address,
      a.price_per_night_from,
      a.currency,
      a.rating,
      a.review_count,
      (
        SELECT json_agg(json_build_object('url', ast.url) ORDER BY ${STAY_PHOTO_ORDER_SQL})
        FROM accommodation_assets aa
        JOIN assets ast ON aa.asset_id = ast.id
        WHERE aa.accommodation_id = a.id
      ) as images
    FROM accommodations a
    WHERE a.type = $1
      AND a.location_zone = $2
      AND a.id != $3
      AND ${publicAccommodationSql('a')}
    ORDER BY a.rating DESC
    LIMIT 4`,
    [accommodation.type, accommodation.location_zone, id]
  );

  return {
    id: accommodation.id,
    name: accommodation.name,
    type: accommodation.type,
    description: accommodation.description,
    shortDescription: accommodation.short_description,
    address: accommodation.address,
    coordinates: accommodation.coordinates,
    locationZone: accommodation.location_zone,
    starRating: num(accommodation.star_rating),
    totalRooms: accommodation.total_rooms,
    checkInTime: accommodation.check_in_time == null ? null : String(accommodation.check_in_time),
    checkOutTime: accommodation.check_out_time == null ? null : String(accommodation.check_out_time),
    pricePerNight: {
      // Цены может не быть (объект с бронью на своём сайте, миграция 1109):
      // null — «цену не называли», а не NaN и не ноль (§4.0).
      from: accommodation.price_per_night_from != null ? parseFloat(accommodation.price_per_night_from) : null,
      to: accommodation.price_per_night_to ? parseFloat(accommodation.price_per_night_to) : null,
      currency: accommodation.currency,
    },
    amenities: Array.isArray(accommodation.amenities) ? (accommodation.amenities as string[]) : [],
    languages: Array.isArray(accommodation.languages) ? (accommodation.languages as unknown[]) : [],
    // Бронь на сайте самого объекта (миграция 1109): живые цены и наличие
    // там, а не у нас. null — своей брони у объекта нет или не указана.
    externalBookingUrl: accommodation.external_booking_url ?? null,
    // Телефон объекта без своего сайта брони (1179): та же проверка формата,
    // что в базе, — мусор не станет tel:-ссылкой, даже если попал в обход CHECK.
    contactPhone: normalizeContactPhone(accommodation.contact_phone),
    contactMessengers: Array.isArray(accommodation.contact_messengers)
      ? NUMBER_MESSENGERS.filter((k) => (accommodation.contact_messengers as unknown[]).includes(k))
      : [],
    // «Не оценён» — null, а не ноль. Ноль читается экраном и планером как
    // ОЦЕНКА, и планер по ней отсеивал объект навсегда (условие
    // «rating >= 3.5», §4.0). Правило одно на все выдачи —
    // lib/reviews/public-rating: оценку подтверждает счёт отзывов.
    rating: publicRating(accommodation.rating, accommodation.review_count),
    reviewCount: Number(accommodation.review_count ?? 0) || 0,
    isVerified: accommodation.is_verified,
    partner: {
      name: accommodation.partner_name,
      email: accommodation.partner_email,
      phone: accommodation.partner_phone,
    },
    images: Array.isArray(accommodation.images) ? (accommodation.images as AccommodationDetailData['images']) : [],
    rooms: roomsResult.rows.map(room => ({
      id: room.id,
      name: room.name,
      roomType: room.room_type,
      description: room.description,
      sizeSqm: num(room.size_sqm),
      maxGuests: Number(room.max_guests ?? 0) || 0,
      bedsConfiguration: Array.isArray(room.beds_configuration) ? (room.beds_configuration as unknown[]) : [],
      amenities: Array.isArray(room.amenities) ? (room.amenities as unknown[]) : [],
      view: room.view,
      availableRooms: room.available_rooms,
      pricePerNight: parseFloat(room.price_per_night),
    })),
    reviews: reviewsResult.rows.map(review => ({
      id: review.id,
      rating: parseFloat(review.rating),
      comment: review.comment,
      createdAt: iso(review.created_at) ?? '',
      // Публичный ответ: без email и фамилии (lib/reviews/public-name).
      user: {
        name: publicReviewerName(review.user_name),
      },
      ownerReply: review.owner_reply,
    })),
    similar: similarResult.rows.map(item => ({
      id: item.id,
      name: item.name,
      type: item.type,
      description: item.short_description,
      address: item.address,
      pricePerNight: item.price_per_night_from != null ? parseFloat(item.price_per_night_from) : null,
      currency: item.currency,
      // То же и у похожих объектов: неоценённый — null.
      rating: publicRating(item.rating, item.review_count),
      reviewCount: Number(item.review_count ?? 0) || 0,
      image: item.images?.[0]?.url || null,
    })),
    createdAt: iso(accommodation.created_at),
    updatedAt: iso(accommodation.updated_at),
  };
}
