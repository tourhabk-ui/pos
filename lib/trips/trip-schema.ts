/**
 * Схема сохранённой поездки — одна на создание и правку (/api/trips,
 * /api/trips/[id]). Чистый модуль.
 *
 * ── Что было до 09.10 ─────────────────────────────────────────────────────
 *
 * Две копии схемы дня в двух роутах, и обе пропускали только название, зону,
 * цену-ориентир и координаты. Zod молча отбрасывает незнакомые ключи — тур
 * дня, его цена и род дня до базы не доходили, а состава группы в поездке не
 * было вовсе. Поэтому страница сохранённой поездки не могла посчитать смету
 * и считала свою: ориентир дня плюс выдуманная цена транспорта (#2304, шаг 2).
 *
 * Теперь день хранит то, что нужно смете и заявке (lib/planner/estimate,
 * lib/planner/plan-for-lead), а поездка — состав и уровень, на которые план
 * собран. Лишнего не хранится: рейтинги, погода и прочее — данные момента,
 * а не плана.
 */
import { z } from 'zod';

const TRANSPORT = z.enum(['walking', 'jeep', 'helicopter', 'boat']);
const ZONE_ENUM = z.enum(['avachinsky', 'western', 'eastern', 'northern']);

export const TripRealTourSchema = z.object({
  tourId: z.string().min(1).max(64),
  priceUnit: z.string().max(40).optional(),
  maxParticipants: z.number().int().min(0).max(1000).optional(),
  durationDays: z.number().int().min(1).max(60).optional(),
  lodgingIncluded: z.boolean().nullable(),
  operatorName: z.string().max(200).optional(),
  priceLabel: z.string().max(200).optional(),
});

export const TripDayPlanSchema = z.object({
  day: z.number().int().min(1),
  zone: ZONE_ENUM,
  title: z.string().min(1).max(255),
  activityType: z.string().max(50),
  priceFrom: z.number().min(0),
  priceTo: z.number().min(0),
  coords: z.tuple([z.number(), z.number()]),
  defaultTransport: TRANSPORT,
  /** Род дня: без него смета не отличит прилёт от тура. Старые поездки — без. */
  type: z.enum(['arrival', 'activity', 'travel', 'rest', 'buffer', 'departure']).optional(),
  realTour: TripRealTourSchema.optional(),
  realPrice: z.number().min(0).max(100_000_000).optional(),
  priceMissing: z.string().max(300).optional(),
  availableDate: z.string().date().optional(),
});

/** Состав и уровень, на которые собран план. Нет — поездка сохранена до 09.10. */
export const TripPartySchema = z.object({
  adults: z.number().int().min(1).max(30),
  children: z.array(z.number().int().min(0).max(17)).max(10),
  budgetTier: z.enum(['economy', 'comfort', 'premium']),
  tripOrigin: z.enum(['visitor', 'local']).optional(),
});

/**
 * Выбранные в плане жильё и поездки перевозчиков (#2304, шаг 3б) — снимок на
 * день сохранения: цена стоянки на группу по правилу брони или «не
 * помещается»; null — цену не посчитали. Форма — lib/planner/plan-choices.
 */
export const TripChoicesSchema = z.object({
  stays: z.array(z.object({
    zone: ZONE_ENUM,
    checkIn: z.string().date(),
    checkOut: z.string().date(),
    nights: z.number().int().min(1).max(60),
    accommodationId: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    price: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('priced'), total: z.number().min(0).max(100_000_000),
        rooms: z.number().int().min(1).max(50), roomId: z.string().max(64),
        roomName: z.string().max(255), maxGuests: z.number().int().min(1).max(100),
      }),
      z.object({ kind: z.literal('no_fit'), people: z.number().int().min(1).max(100) }),
    ]).nullable(),
  })).max(8),
  transfers: z.array(z.object({
    tripId: z.string().min(1).max(64),
    date: z.string().date(),
    from: z.string().max(255),
    to: z.string().max(255),
    seats: z.number().int().min(1).max(60),
    pricePerSeat: z.number().min(0).max(10_000_000).nullable(),
    carrier: z.string().max(255),
  })).max(6),
});

export type TripDayPlan = z.infer<typeof TripDayPlanSchema>;
export type TripParty = z.infer<typeof TripPartySchema>;
export type TripChoices = z.infer<typeof TripChoicesSchema>;

export const TRANSPORT_SCHEMA = TRANSPORT;
