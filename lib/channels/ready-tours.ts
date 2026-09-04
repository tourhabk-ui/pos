/**
 * Что уходит на чужие витрины — один отбор на все каналы.
 *
 * До 04.09 обе ленты (Авито и Яндекс) отбирали туры условием
 * `is_active AND is_published` и ничем больше. Этого достаточно, чтобы на
 * чужую площадку уехала карточка со стознаковым описанием, без фото и без
 * ответа «как я туда попаду» — под именем нашего оператора. Перепись
 * готовности при этом существовала и считала ровно это, но жила в кроне, а
 * каналы про неё не знали.
 *
 * Здесь отбор один, и оба канала им пользуются. Разложить его по двум роутам
 * значило бы завести два правила: они разойдутся на первой же правке, и
 * разойдутся молча (§12 про стиль линии — там это уже случалось трижды).
 *
 * Придержанные туры возвращаются вместе с готовыми: канал обязан сказать,
 * сколько и почему он не отдал. Молчание читалось бы как «туров мало», а не
 * как «туры не готовы, и вот чего им не хватает».
 */

import { pool } from '@/lib/db-pool';
import type { ChannelTour } from '@/lib/channels/types';
import { missingFields, type ReadinessRow } from '@/lib/tours/readiness';

interface FeedRow {
  id: number; title: string; description: string | null;
  short_description: string | null; activity_type: string;
  location_name: string | null; latitude: string | number | null;
  longitude: string | number | null; base_price: string;
  max_participants: number; duration_hours: string | number | null;
  difficulty: string | null; photos: string[] | null;
  included: unknown; season_start: string | null; season_end: string | null;
  tripster_experience_id: string | null; avito_listing_id: string | null;
  sputnik8_product_id: string | null;
  operator_name: string | null; operator_phone: string | null;
  description_chars: number; photo_count: number;
  pickup_type: ReadinessRow['pickup_type']; pickup_details_chars: number;
  has_meeting_point: boolean; has_cancellation_policy: boolean;
  has_coords: boolean; has_operator_contact: boolean;
}

export interface FeedSelection {
  tours: ChannelTour[];
  /** Сколько придержано и по каким причинам — для заголовков ответа. */
  withheld: number;
  reasons: string[];
}

const SQL = `
  SELECT
    ot.id, ot.title, ot.description, ot.short_description,
    ot.activity_type, ot.location_name, ot.latitude, ot.longitude,
    ot.base_price, ot.max_participants, ot.duration_hours,
    ot.difficulty, ot.photos, ot.included,
    ot.season_start::text AS season_start, ot.season_end::text AS season_end,
    ot.tripster_experience_id, ot.avito_listing_id, ot.sputnik8_product_id,
    COALESCE(p.company_name, p.name)                AS operator_name,
    -- Телефон оператора, а не платформы: звонок «в никуда» убивает лид,
    -- ради которого объявление и размещалось.
    p.contacts->>'phone'                            AS operator_phone,
    COALESCE(LENGTH(ot.description), 0)             AS description_chars,
    COALESCE(ARRAY_LENGTH(ot.photos, 1), 0)         AS photo_count,
    ot.pickup_type,
    COALESCE(LENGTH(TRIM(ot.pickup_details)), 0)    AS pickup_details_chars,
    (ot.meeting_point IS NOT NULL AND LENGTH(TRIM(ot.meeting_point)) > 0) AS has_meeting_point,
    (ot.cancellation_policy IS NOT NULL AND LENGTH(TRIM(ot.cancellation_policy)) > 0) AS has_cancellation_policy,
    (ot.latitude IS NOT NULL AND ot.longitude IS NOT NULL)                AS has_coords,
    (p.contacts IS NOT NULL AND p.contacts::text <> '{}')                 AS has_operator_contact
  FROM operator_tours ot
  LEFT JOIN partners p ON p.id = ot.operator_id
  WHERE ot.is_active = true
    AND ot.is_published = true
    AND ot.deleted_at IS NULL
  ORDER BY ot.id
`;

function toChannelTour(r: FeedRow): ChannelTour {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    short_description: r.short_description,
    activity_type: r.activity_type ?? '',
    location_name: r.location_name,
    latitude: r.latitude !== null ? Number(r.latitude) : null,
    longitude: r.longitude !== null ? Number(r.longitude) : null,
    base_price: Number(r.base_price),
    max_participants: r.max_participants,
    duration_hours: r.duration_hours !== null ? Number(r.duration_hours) : null,
    difficulty: r.difficulty,
    photos: Array.isArray(r.photos) ? r.photos : [],
    included: Array.isArray(r.included) ? r.included as string[] : [],
    season_start: r.season_start,
    season_end: r.season_end,
    tripster_experience_id: r.tripster_experience_id,
    avito_listing_id: r.avito_listing_id,
    sputnik8_product_id: r.sputnik8_product_id,
    operator_name: r.operator_name,
    operator_phone: r.operator_phone,
  };
}

/** Готовые к выкладке туры плюс честный счёт придержанных. */
export async function selectFeedTours(): Promise<FeedSelection> {
  const { rows } = await pool.query<FeedRow>(SQL);

  const tours: ChannelTour[] = [];
  const reasons = new Set<string>();
  let withheld = 0;

  for (const r of rows) {
    const missing = missingFields({
      id: r.id,
      title: r.title,
      operator_id: null,
      operator_name: r.operator_name,
      description_chars: r.description_chars,
      photo_count: r.photo_count,
      base_price: Number(r.base_price),
      duration_hours: r.duration_hours !== null ? Number(r.duration_hours) : null,
      pickup_type: r.pickup_type,
      pickup_details_chars: r.pickup_details_chars,
      has_meeting_point: r.has_meeting_point,
      has_cancellation_policy: r.has_cancellation_policy,
      has_coords: r.has_coords,
      has_operator_contact: r.has_operator_contact,
      included_count: Array.isArray(r.included) ? (r.included as unknown[]).length : 0,
      // Шаги программы перепись считает отдельно и НЕ блокирует ими выкладку:
      // здесь честный ноль, а не выдуманное число.
      program_steps: 0,
    });
    if (missing.length === 0) { tours.push(toChannelTour(r)); continue; }
    withheld++;
    for (const m of missing) reasons.add(m);
  }

  return { tours, withheld, reasons: [...reasons].sort() };
}

/** Заголовки ответа ленты: сколько придержано и почему. */
export function feedHeaders(sel: FeedSelection): Record<string, string> {
  return {
    'X-Withheld-Tours': String(sel.withheld),
    'X-Withheld-Reasons': sel.reasons.join(',') || 'none',
  };
}
