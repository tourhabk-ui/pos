/**
 * lib/planner/trip-groups.ts — группа для общего плана поездки (#2226, миграция 1184).
 *
 * Организатор заводит группу на даты и рассылает ссылку; каждый участник
 * отмечает свои пожелания (интересы, подготовку, флаги без диагнозов, бюджет)
 * с согласием на обработку данных; сводит их правило lib/planner/group-merge,
 * план собирает тот же движок и кладёт черновиком (/trip/<id>).
 *
 * Наружу — только сводка. Строки участников не возвращает ни одна функция,
 * кроме внутренней `loadGroup` (сторож trip-groups-no-member-rows): по ссылке
 * группы её видит любой, у кого ссылка, а флаги участника — его дело.
 *
 * Три исхода чтения (§4.0): группа есть; группы нет (не было, истекла, id не
 * UUID); прочитать не смогли.
 */

import { pool } from '@/lib/db-pool';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import { recommendTrip } from './engine';
import { isDraftId, saveDraft } from './plan-drafts';
import { mergeGroupWishes, type GroupProfile, type MemberWishes } from './group-merge';
import type { PlanParams } from './plan-edit';

/** Сколько участников в группе: дальше это уже не группа, а сбор заявок. */
export const MAX_GROUP_MEMBERS = 15;

function logFail(what: string, err: unknown): void {
  const e = err as { code?: string; message?: string } | undefined;
  console.error(`[trip-groups] ${what}`, { sqlstate: e?.code, message: e?.message });
}

export interface TripGroup {
  id: string;
  arrivalDate: string;
  departureDate: string;
  expiresAt: string;
  members: MemberWishes[];
}

export type GroupRead = { kind: 'found'; group: TripGroup } | { kind: 'missing' } | { kind: 'failed' };

/** Те же границы, что у make_trip_plan: 3–21 день, не в прошлом, не дальше двух лет. */
export function groupDatesProblem(arrival: string, departure: string, today: string): string | null {
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const d = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return 'Такой даты нет в календаре.';
  if (arrival < today) return 'Дата прилёта уже прошла.';
  if (a > Date.parse(`${today}T00:00:00Z`) + 730 * 86_400_000) return 'Планер собирает поездки не дальше чем на два года вперёд.';
  const days = Math.round((d - a) / 86_400_000) + 1;
  if (days < 3 || days > 21) return 'Поездка — от 3 до 21 дня.';
  return null;
}

/** Завести группу. null — не записали (лог есть). */
export async function createGroup(arrivalDate: string, departureDate: string): Promise<string | null> {
  try {
    await pool.query('DELETE FROM trip_groups WHERE expires_at < NOW()');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trip_groups (arrival_date, departure_date) VALUES ($1::date, $2::date) RETURNING id::text`,
      [arrivalDate, departureDate],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('группа не записана', err);
    return null;
  }
}

interface MemberRow {
  interests: string[]; fitness: MemberWishes['fitness']; no_hard_climbs: boolean; seasickness: boolean;
  limited_mobility: boolean; youngest_child: number | null; budget: MemberWishes['budget'];
}

/** Внутреннее чтение — со строками участников. Наружу не отдавать. */
async function loadGroup(id: string): Promise<GroupRead> {
  if (!isDraftId(id)) return { kind: 'missing' };
  try {
    const { rows } = await pool.query<{ id: string; arrival_date: string; departure_date: string; expires_at: Date | string }>(
      `SELECT id::text, arrival_date::text, departure_date::text, expires_at
         FROM trip_groups WHERE id = $1::uuid AND expires_at > NOW()`,
      [id.trim()],
    );
    const g = rows[0];
    if (!g) return { kind: 'missing' };
    const { rows: m } = await pool.query<MemberRow>(
      `SELECT interests, fitness, no_hard_climbs, seasickness, limited_mobility, youngest_child, budget
         FROM trip_group_members WHERE group_id = $1::uuid ORDER BY created_at`,
      [g.id],
    );
    return {
      kind: 'found',
      group: {
        id: g.id, arrivalDate: g.arrival_date, departureDate: g.departure_date,
        expiresAt: g.expires_at instanceof Date ? g.expires_at.toISOString() : String(g.expires_at),
        members: m.map((r) => ({
          interests: r.interests ?? [], fitness: r.fitness, noHardClimbs: r.no_hard_climbs,
          seasickness: r.seasickness, limitedMobility: r.limited_mobility,
          youngestChild: r.youngest_child, budget: r.budget,
        })),
      },
    };
  } catch (err) {
    logFail('группа не прочитана', err);
    return { kind: 'failed' };
  }
}

/** Что видит любой по ссылке группы: даты и сводка, без строк участников. */
export interface GroupSummary {
  id: string;
  arrivalDate: string;
  departureDate: string;
  expiresAt: string;
  members: number;
  maxMembers: number;
  profile: GroupProfile | null;
}

export type SummaryRead = { kind: 'found'; summary: GroupSummary } | { kind: 'missing' } | { kind: 'failed' };

export async function groupSummary(id: string): Promise<SummaryRead> {
  const read = await loadGroup(id);
  if (read.kind !== 'found') return read;
  const g = read.group;
  return {
    kind: 'found',
    summary: {
      id: g.id, arrivalDate: g.arrivalDate, departureDate: g.departureDate, expiresAt: g.expiresAt,
      members: g.members.length, maxMembers: MAX_GROUP_MEMBERS, profile: mergeGroupWishes(g.members),
    },
  };
}

export type AddMemberResult = 'added' | 'missing' | 'full' | 'failed';

/** Добавить пожелания участника. Согласие обязательно — без него сюда не доходят. */
export async function addMember(id: string, w: MemberWishes, consent: PdConsentRecord): Promise<AddMemberResult> {
  if (!isDraftId(id)) return 'missing';
  try {
    // Потолок и запись — одним запросом: два параллельных участника не
    // проскочат шестнадцатым.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trip_group_members
         (group_id, interests, fitness, no_hard_climbs, seasickness, limited_mobility, youngest_child, budget,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       SELECT g.id, $2::text[], $3::varchar, $4::boolean, $5::boolean, $6::boolean, $7::smallint, $8::varchar,
              $9::timestamptz, $10::varchar, $11::varchar, $12::varchar
         FROM trip_groups g
        WHERE g.id = $1::uuid AND g.expires_at > NOW()
          AND (SELECT COUNT(*) FROM trip_group_members m WHERE m.group_id = g.id) < $13::int
       RETURNING id::text`,
      [id.trim(), w.interests, w.fitness, w.noHardClimbs, w.seasickness, w.limitedMobility, w.youngestChild, w.budget,
        consent.at.toISOString(), consent.ip, consent.source, consent.version, MAX_GROUP_MEMBERS],
    );
    if (rows[0]) return 'added';
    const exists = await loadGroup(id);
    if (exists.kind === 'failed') return 'failed';
    return exists.kind === 'missing' ? 'missing' : 'full';
  } catch (err) {
    logFail('пожелания участника не записаны', err);
    return 'failed';
  }
}

export type GroupPlanResult =
  | { kind: 'planned'; draftId: string }
  | { kind: 'empty' }        // ни одного участника — сводить нечего
  | { kind: 'no_days' }      // движок не собрал ни дня (сезон, ограничения)
  | { kind: 'missing' }
  | { kind: 'failed' };

/**
 * Собрать план группы: сводка → профиль → `recommendTrip` → черновик.
 * Взрослых — по числу участников; детей — младший возраст группы.
 */
export async function buildGroupPlan(id: string): Promise<GroupPlanResult> {
  const read = await loadGroup(id);
  if (read.kind !== 'found') return read;
  const g = read.group;
  const profile = mergeGroupWishes(g.members);
  if (!profile) return { kind: 'empty' };
  if (profile.interests.length === 0) return { kind: 'no_days' };
  const params: PlanParams = {
    interests: profile.interests,
    arrivalDate: g.arrivalDate,
    departureDate: g.departureDate,
    adults: profile.members,
    children: profile.children,
    budgetTier: profile.budget,
    fitnessLevel: profile.fitness,
    ...(profile.seasickness ? { seasickness: true } : {}),
    ...(profile.limitedMobility ? { mobilityLevel: 'limited' as const } : {}),
  };
  try {
    const rec = await recommendTrip({
      interests: params.interests, arrivalDate: params.arrivalDate, departureDate: params.departureDate,
      adults: params.adults, children: params.children, fitnessLevel: profile.fitness,
      budgetTier: params.budgetTier, riskMode: 'safe_only',
      ...(params.seasickness ? { seasickness: true } : {}),
      ...(params.mobilityLevel ? { mobilityLevel: params.mobilityLevel } : {}),
    }, { itinerary: 'plain' });
    if (rec.days.length === 0) return { kind: 'no_days' };
    const draftId = await saveDraft({ params, days: rec.days }, 'group', undefined);
    return draftId ? { kind: 'planned', draftId } : { kind: 'failed' };
  } catch (err) {
    logFail('план группы не собран', err);
    return { kind: 'failed' };
  }
}
