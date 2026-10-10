/**
 * Channel Manager — общие типы для интеграций с внешними маркетплейсами
 */

import type { CatalogAvailability } from '@/lib/tours/catalog-availability';

export type ChannelName = 'tripster' | 'avito' | 'sputnik8';

export interface ChannelTour {
  id: number;
  /**
   * Адрес карточки по имени (ЧПУ, lib/tours/tour-url). Нет — ссылка числом,
   * которое уводит 308 на адрес; лента, отдающая площадке редирект вместо
   * карточки, — то, что сверка 10.10 нашла в фидах Яндекса и Авито.
   */
  slug?: string | null;
  title: string;
  description: string | null;
  short_description: string | null;
  activity_type: string;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  base_price: number;
  max_participants: number;
  duration_hours: number | null;
  difficulty: string | null;
  photos: string[];
  included: string[];
  season_start: string | null;
  season_end: string | null;
  /**
   * За что цена: `per_person` / `per_tour` / `per_day_per_person`; null — не
   * записано. Без неё 25 000 «с человека в день» и 45 000 «за группу» на
   * витрине неотличимы (замер 30.09).
   */
  price_unit?: string | null;
  /**
   * Даты тура по общему правилу каталога (`catalogAvailability`): отбор лент
   * считает его один раз, генераторы только читают. Нет поля — не считали.
   */
  availability?: CatalogAvailability;
  // Оператор — для контактов в объявлении. Площадка обязана показывать телефон
  // того, кто проводит тур: звонок «в платформу» без человека на конце убивает
  // лид, ради которого объявление и размещалось.
  operator_name?: string | null;
  operator_phone?: string | null;
  // ID на внешних платформах
  tripster_experience_id: string | null;
  avito_listing_id: string | null;
  sputnik8_product_id: string | null;
}

export interface ChannelBooking {
  external_id: string;
  channel: ChannelName;
  tour_id: number;
  status: 'new' | 'confirmed' | 'cancelled';
  tourist_name: string;
  tourist_email: string;
  tourist_phone: string;
  participants: number;
  booking_date: string;   // YYYY-MM-DD
  amount: number;
  raw_payload: Record<string, unknown>;
}

export interface PushBookingInput {
  tour: ChannelTour;
  tourist_name: string;
  tourist_email: string;
  tourist_phone: string;
  participants: number;
  booking_date: string;
  booking_time?: string;  // HH:MM:SS
  message?: string;
}

export interface PushBookingResult {
  success: boolean;
  external_id?: string;
  error?: string;
}

export interface ChannelAdapter {
  name: ChannelName;
  /**
   * Заданы ли ключи канала. Отдельный вопрос, а не пустой список заказов:
   * «не настроен» и «заказов нет» — разные состояния (§4.0), и до 26.09 крон
   * отвечал на оба одинаково — нулём.
   */
  isConfigured(): boolean;
  pushBooking(input: PushBookingInput): Promise<PushBookingResult>;
  pollOrders(since: Date): Promise<ChannelBooking[]>;
}
