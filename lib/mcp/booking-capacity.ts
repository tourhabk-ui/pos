/**
 * Заявка на группу больше, чем тур берёт на выезд, — запросом оператору, а не
 * отказом (слово владельца 08.11).
 *
 * Разбор 08.11: план «вулканы, 24 человека» отвечал «свободно 4 из 4, вас 24»,
 * а create_booking_request — «в ближайшие 30 дней подходящих дат нет». Гид
 * Запорожец же для большой группы нанимает ещё машины, и группу на 24
 * человека взял бы и другой оператор. Владелец: «Слать оператору запросом»;
 * если адресат не может — «Да, после „Не могу“» отдавать другим операторам
 * (lib/leads/followup-scope, GROUP_DECLINED_LEAD_SQL).
 *
 * Когда это запрос, а не отказ:
 *   - у тура «группа не ограничена» (1342, 1410) и мест на дату меньше, чем
 *     людей: число на дате — потолок одной заявки платформы, а не гида;
 *   - группа больше потолка тура (`max_participants`): другая дата этого не
 *     изменит, и отказ «мест нет» был бы неправдой о причине.
 * Мест меньше, чем людей, а группа в потолок тура входит, — прежний отказ с
 * ближайшими датами: дата занята, и это правда.
 */
import { pool } from '@/lib/db-pool';
import { isGroupSizeUnlimited } from '@/lib/tours/group-size';

export interface TourGroupFacts {
  /** Потолок тура (`max_participants`); null — не записан. */
  max: number | null;
  unlimited: boolean;
  /** Вид тура — по нему добивка ищет других операторов. */
  activityType: string | null;
}

/** null — прочитать не удалось (в лог); заявка тогда идёт прежним путём. */
export async function loadTourGroupFacts(tourId: number): Promise<TourGroupFacts | null> {
  try {
    const { rows } = await pool.query<{ max_participants: number | string | null; group_size_unlimited: boolean | null; activity_type: string | null }>(
      'SELECT max_participants, group_size_unlimited, activity_type FROM operator_tours WHERE id = $1',
      [tourId],
    );
    const row = rows[0];
    if (!row) return null;
    const n = Number(row.max_participants);
    return {
      max: Number.isFinite(n) && n > 0 ? Math.floor(n) : null,
      unlimited: isGroupSizeUnlimited(row),
      activityType: row.activity_type ?? null,
    };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[mcp] группа тура не прочитана:', typeof code === 'string' ? code : '', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Заявка на группу сверх мест — полем итога заявки. */
export interface GroupOverSeats {
  code: 'group_over_seats';
  tour_id: number;
  /** Свободно на дату; null — расписания у тура нет. */
  seats_on_date: number | null;
  /** Потолок тура; null — не записан или группа тура не ограничена. */
  tour_max: number | null;
  participants: number;
}

/**
 * Запрос ли это на большую группу (а не отказ). `hasSchedule` — у тура есть
 * календарь; без него места уточняет оператор, и запросом идёт только группа
 * сверх потолка тура (запрос мест такую не примет).
 */
export function groupOverSeats(
  facts: TourGroupFacts | null,
  a: { tourId: number; participants: number; remaining: number; hasSchedule: boolean },
): GroupOverSeats | null {
  if (!facts || a.remaining >= a.participants) return null;
  const overCeiling = facts.max !== null && a.participants > facts.max;
  const isRequest = a.hasSchedule ? facts.unlimited || overCeiling : overCeiling;
  if (!isRequest) return null;
  return {
    code: 'group_over_seats',
    tour_id: a.tourId,
    seats_on_date: a.hasSchedule ? a.remaining : null,
    tour_max: facts.unlimited ? null : facts.max,
    participants: a.participants,
  };
}

/** Строка о местах в ответе и в заявке оператору. */
export function groupOverSeatsLine(g: GroupOverSeats): string {
  const seats = g.seats_on_date === null ? 'расписания у тура в системе нет' : `на дату свободно ${g.seats_on_date} мест`;
  const ceiling = g.tour_max !== null ? `, тур берёт до ${g.tour_max} чел. (так записано у тура)` : '';
  return `${seats}${ceiling}, а в группе ${g.participants} чел.`;
}
