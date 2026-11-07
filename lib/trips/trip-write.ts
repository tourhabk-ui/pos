/**
 * lib/trips/trip-write.ts — запись сохранённой поездки (/api/trips и
 * /api/trips/[id]): одна схема полей на создание и правку и сборка правки.
 * Чистый модуль: SQL собирается здесь, выполняют роуты.
 *
 * ── Что было до 07.11 (аудит планировщика, волна 2.3–2.4) ─────────────────
 *
 * H9. Правка писала каждое поле через `COALESCE($n, поле)`: прислали null —
 * осталось прежнее. Убранный номер рейса и время вылета стереть было нельзя,
 * дата прилёта — тоже. Теперь правка трогает только присланные поля, а null —
 * это «стереть».
 *
 * H6, H7. Галочки «жильё» и «машина» и предупреждения плана в поездку не
 * уходили вовсе (миграция 1397 завела колонки).
 *
 * H12. Повтор сохранения создавал вторую поездку: ключа повтора не было.
 * Планировщик даёт ключ на сессию плана; POST с тем же ключом обновляет ту же
 * поездку (`ON CONFLICT` по уникальному индексу живых поездок человека).
 */
import { z } from 'zod';
import { TripChoicesSchema, TripDayPlanSchema, TripPartySchema, TripWarningSchema } from './trip-schema';

const TRANSPORT_BY_DAY = z.record(z.string(), z.enum(['walking', 'jeep', 'helicopter', 'boat']));

/** Поля поездки, общие для создания и правки (у правки все необязательны). */
const TripFields = {
  title: z.string().min(1).max(255),
  arrivalDate: z.string().date().nullable(),
  departureDate: z.string().date().nullable(),
  places: z.array(z.string()).max(20),
  activities: z.array(z.string()).max(20),
  days: z.array(TripDayPlanSchema).max(60),
  transportByDay: TRANSPORT_BY_DAY,
  flightArrival: z.string().max(20).nullable(),
  flightDeparture: z.string().max(20).nullable(),
  flightArrivalTime: z.string().max(5).nullable(),
  flightDepartureTime: z.string().max(5).nullable(),
  needsAirportTransfer: z.boolean(),
  /** Жильё и машина напрокат (H6); null — не записано. */
  needsLodging: z.boolean().nullable(),
  needsCar: z.boolean().nullable(),
  /** Состав и уровень плана — для сметы и заявки (#2304, шаг 2). */
  party: TripPartySchema.nullable(),
  /** Выбранное жильё — снимок на день сохранения; пустые списки — выбор снят (#2304, шаг 3б). */
  choices: TripChoicesSchema.nullable(),
  /** Предупреждения плана — снимок на день сохранения (H7). */
  warnings: z.array(TripWarningSchema).max(100).nullable(),
} as const;

export const CreateTripSchema = z.object({
  title: TripFields.title.default('Мой маршрут'),
  arrivalDate: TripFields.arrivalDate.optional(),
  departureDate: TripFields.departureDate.optional(),
  places: TripFields.places.default([]),
  activities: TripFields.activities.default([]),
  days: TripFields.days.default([]),
  transportByDay: TripFields.transportByDay.default({}),
  flightArrival: TripFields.flightArrival.optional(),
  flightDeparture: TripFields.flightDeparture.optional(),
  flightArrivalTime: TripFields.flightArrivalTime.optional(),
  flightDepartureTime: TripFields.flightDepartureTime.optional(),
  needsAirportTransfer: TripFields.needsAirportTransfer.optional(),
  needsLodging: TripFields.needsLodging.optional(),
  needsCar: TripFields.needsCar.optional(),
  party: TripFields.party.optional(),
  choices: TripFields.choices.optional(),
  warnings: TripFields.warnings.optional(),
  /** Ключ повтора сохранения (H12): тот же ключ — та же поездка. */
  saveKey: z.string().uuid().optional(),
});

export const UpdateTripSchema = z.object({
  title: TripFields.title.optional(),
  arrivalDate: TripFields.arrivalDate.optional(),
  departureDate: TripFields.departureDate.optional(),
  places: TripFields.places.optional(),
  activities: TripFields.activities.optional(),
  days: TripFields.days.optional(),
  transportByDay: TripFields.transportByDay.optional(),
  flightArrival: TripFields.flightArrival.optional(),
  flightDeparture: TripFields.flightDeparture.optional(),
  flightArrivalTime: TripFields.flightArrivalTime.optional(),
  flightDepartureTime: TripFields.flightDepartureTime.optional(),
  needsAirportTransfer: TripFields.needsAirportTransfer.optional(),
  needsLodging: TripFields.needsLodging.optional(),
  needsCar: TripFields.needsCar.optional(),
  party: TripFields.party.optional(),
  choices: TripFields.choices.optional(),
  warnings: TripFields.warnings.optional(),
});

export type CreateTripInput = z.infer<typeof CreateTripSchema>;
export type UpdateTripInput = z.infer<typeof UpdateTripSchema>;

/**
 * Поле поездки → колонка и запись значения. Список закрытый: имена колонок в
 * SQL берутся только отсюда, значения — параметрами.
 */
const COLUMNS: ReadonlyArray<{ key: keyof UpdateTripInput; column: string; json?: true; cast?: string }> = [
  { key: 'title', column: 'title' },
  { key: 'arrivalDate', column: 'arrival_date', cast: '::date' },
  { key: 'departureDate', column: 'departure_date', cast: '::date' },
  { key: 'places', column: 'places' },
  { key: 'activities', column: 'activities' },
  { key: 'days', column: 'days', json: true },
  { key: 'transportByDay', column: 'transport_by_day', json: true },
  { key: 'flightArrival', column: 'flight_arrival' },
  { key: 'flightDeparture', column: 'flight_departure' },
  { key: 'flightArrivalTime', column: 'flight_arrival_time' },
  { key: 'flightDepartureTime', column: 'flight_departure_time' },
  { key: 'needsAirportTransfer', column: 'needs_airport_transfer' },
  { key: 'needsLodging', column: 'needs_lodging' },
  { key: 'needsCar', column: 'needs_car' },
  { key: 'party', column: 'party', json: true },
  { key: 'choices', column: 'choices', json: true },
  { key: 'warnings', column: 'warnings', json: true },
];

/** Колонки, которые NOT NULL в базе: null для них — не «стереть», а ошибка ввода. */
const NOT_NULL = new Set(['title', 'places', 'activities', 'days', 'transport_by_day', 'needs_airport_transfer']);

/**
 * Правка: SET только для присланных полей; null — стереть. `firstParam` —
 * номер первого параметра (перед ним роут ставит свои: id поездки и владельца).
 */
export function buildTripUpdate(input: UpdateTripInput, firstParam: number): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const c of COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(input, c.key)) continue;
    const v = input[c.key];
    if (v === undefined) continue;
    if (v === null && NOT_NULL.has(c.column)) continue;
    values.push(v === null ? null : c.json ? JSON.stringify(v) : v);
    sets.push(`${c.column} = $${firstParam + values.length - 1}${c.json ? '::jsonb' : c.cast ?? ''}`);
  }
  return { sets, values };
}

/** Колонки поездки, которые читает страница поездки и её действия. */
export const TRIP_SELECT = `id, user_id, title, arrival_date, departure_date, places, activities, days,
  transport_by_day, flight_arrival, flight_departure, flight_arrival_time,
  flight_departure_time, needs_airport_transfer, needs_lodging, needs_car, party, choices, warnings,
  is_public, created_at, updated_at, deleted_at`;

/**
 * Создание: INSERT, а с ключом повтора — upsert по уникальному индексу живых
 * поездок человека (1397): повторный POST после потерянного ответа обновляет
 * ту же поездку, а не заводит вторую. `inserted` — создана ли строка сейчас.
 */
export function buildTripInsert(userId: string, d: CreateTripInput): { sql: string; values: unknown[] } {
  const cols = [
    'user_id', 'title', 'arrival_date', 'departure_date', 'places', 'activities', 'days', 'transport_by_day',
    'flight_arrival', 'flight_departure', 'flight_arrival_time', 'flight_departure_time', 'needs_airport_transfer',
    'needs_lodging', 'needs_car', 'party', 'choices', 'warnings', 'save_key',
  ];
  const values: unknown[] = [
    userId,
    d.title,
    d.arrivalDate ?? null,
    d.departureDate ?? null,
    d.places,
    d.activities,
    JSON.stringify(d.days),
    JSON.stringify(d.transportByDay),
    d.flightArrival ?? null,
    d.flightDeparture ?? null,
    d.flightArrivalTime ?? null,
    d.flightDepartureTime ?? null,
    d.needsAirportTransfer ?? false,
    d.needsLodging ?? null,
    d.needsCar ?? null,
    d.party ? JSON.stringify(d.party) : null,
    d.choices ? JSON.stringify(d.choices) : null,
    d.warnings ? JSON.stringify(d.warnings) : null,
    d.saveKey ?? null,
  ];
  const casts: Record<string, string> = {
    arrival_date: '::date', departure_date: '::date', days: '::jsonb', transport_by_day: '::jsonb',
    party: '::jsonb', choices: '::jsonb', warnings: '::jsonb', save_key: '::uuid', user_id: '::uuid',
  };
  const placeholders = cols.map((c, i) => `$${i + 1}${casts[c] ?? ''}`);
  // При повторе пишутся все поля, кроме владельца и ключа: в повторе — то,
  // что человек видит сейчас.
  const update = cols.filter((c) => c !== 'user_id' && c !== 'save_key').map((c) => `${c} = EXCLUDED.${c}`);
  const sql = `
    INSERT INTO user_trips (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (user_id, save_key) WHERE save_key IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET ${update.join(', ')}, updated_at = NOW()
    RETURNING ${TRIP_SELECT}, (xmax = 0) AS inserted`;
  return { sql, values };
}
