/**
 * lib/planner/group-merge.ts — пожелания группы в один профиль поездки (#2226).
 *
 * Решение владельца 08.10: участники по ссылке отмечают свои пожелания без
 * диагнозов — обезличенными флагами, — и планер сводит их в один маршрут.
 * Сведение — правилом, а не моделью: правило можно проверить и объяснить, и
 * один и тот же набор пожеланий всегда даёт один и тот же профиль.
 *
 * Правило:
 *   - интересы — объединение с весом по числу голосов; занятие, которое
 *     ограничение кого-то из группы исключает, не ставится, и это сказано;
 *   - ограничения — пересечение: подготовка и бюджет по самому слабому,
 *     младший ребёнок — самый младший; «укачивает» и «ограничена подвижность»
 *     у одного — правило для всех (безопасность и сложность по самому слабому);
 *   - конфликт называется словами, а не прячется.
 *
 * Сам план собирает тот же движок (`recommendTrip`) — своего подбора здесь
 * нет (CLAUDE.md: новый движок подбора заводить запрещено).
 *
 * Модуль без базы — его читают и сервер, и страница группы.
 * Сторож: tests/unit/group-merge.test.ts.
 */

import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES, type FitnessLevel } from './constants';

export type GroupBudget = 'economy' | 'comfort' | 'premium';

/** Пожелания одного участника. Ни имени, ни свободного текста. */
export interface MemberWishes {
  interests: string[];
  fitness: FitnessLevel;
  /** «Тяжёлые подъёмы не подходят» — без диагноза. */
  noHardClimbs: boolean;
  seasickness: boolean;
  limitedMobility: boolean;
  /** Возраст младшего ребёнка, который едет с участником; нет детей — null. */
  youngestChild: number | null;
  budget: GroupBudget;
}

export const FITNESS_ORDER: readonly FitnessLevel[] = ['beginner', 'moderate', 'active'];
export const BUDGET_ORDER: readonly GroupBudget[] = ['economy', 'comfort', 'premium'];

export const FITNESS_LABEL: Record<FitnessLevel, string> = {
  beginner: 'спокойный темп', moderate: 'средняя подготовка', active: 'хорошая подготовка',
};
export const BUDGET_LABEL: Record<GroupBudget, string> = {
  economy: 'эконом', comfort: 'комфорт', premium: 'премиум',
};

/** Занятия, которые участник может выбрать: ключи движка с русским именем. */
export const GROUP_INTEREST_KEYS: readonly string[] = Object.keys(ACTIVITY_NAMES)
  .filter((k) => k in ACTIVITY_CONSTRAINTS);

export const MAX_GROUP_INTERESTS = 4;

export interface GroupProfile {
  /** Сколько участников учтено. */
  members: number;
  /** Интересы плана — по числу голосов, не больше MAX_GROUP_INTERESTS. */
  interests: string[];
  votes: Array<{ interest: string; votes: number }>;
  fitness: FitnessLevel;
  budget: GroupBudget;
  seasickness: boolean;
  limitedMobility: boolean;
  /** Возраст самого младшего ребёнка группы; детей нет — пусто. */
  children: number[];
  /** Расхождения и что с ними сделано — словами. */
  conflicts: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const minOf = <T>(order: readonly T[], values: T[]): T =>
  order[Math.min(...values.map((v) => order.indexOf(v)))];

/** Что из ограничений группы исключает занятие; null — не исключает. */
function excludedBy(interest: string, g: { noHardClimbs: number; seasickness: number }): string | null {
  const c = ACTIVITY_CONSTRAINTS[interest];
  if (!c) return null;
  if (g.noHardClimbs > 0 && c.difficulty === 'hard') return '«тяжёлые подъёмы не подходят»';
  if (g.seasickness > 0 && (interest === 'boat_trip' || interest === 'sea')) return '«укачивает»';
  return null;
}

/**
 * Свести пожелания группы. Пустая группа — null: план без единого пожелания
 * был бы планом по умолчанию, выданным за план группы.
 */
export function mergeGroupWishes(members: readonly MemberWishes[]): GroupProfile | null {
  if (members.length === 0) return null;
  const conflicts: string[] = [];

  const flags = {
    noHardClimbs: members.filter((m) => m.noHardClimbs).length,
    seasickness: members.filter((m) => m.seasickness).length,
    limited: members.filter((m) => m.limitedMobility).length,
  };

  // Подготовка — по самому слабому; «без тяжёлых подъёмов» — это начальный уровень.
  const fitness = flags.noHardClimbs > 0
    ? 'beginner'
    : minOf(FITNESS_ORDER, members.map((m) => m.fitness));
  const wanted = new Set(members.map((m) => m.fitness));
  if (wanted.size > 1 || (flags.noHardClimbs > 0 && members.some((m) => m.fitness !== 'beginner'))) {
    conflicts.push(`Подготовка в группе разная — темп плана по самому слабому: ${FITNESS_LABEL[fitness]}.`);
  }

  const budget = minOf(BUDGET_ORDER, members.map((m) => m.budget));
  if (new Set(members.map((m) => m.budget)).size > 1) {
    conflicts.push(`Бюджет у участников разный — жильё по самому скромному: ${BUDGET_LABEL[budget]}.`);
  }

  const ages = members.map((m) => m.youngestChild).filter((a): a is number => a !== null && Number.isFinite(a));
  const children = ages.length > 0 ? [Math.min(...ages)] : [];

  // Голоса за интересы.
  const count = new Map<string, number>();
  for (const m of members) {
    for (const i of new Set(m.interests)) {
      if (GROUP_INTEREST_KEYS.includes(i)) count.set(i, (count.get(i) ?? 0) + 1);
    }
  }
  const votes = [...count.entries()]
    .map(([interest, v]) => ({ interest, votes: v }))
    .sort((a, b) => b.votes - a.votes || GROUP_INTEREST_KEYS.indexOf(a.interest) - GROUP_INTEREST_KEYS.indexOf(b.interest));

  const interests: string[] = [];
  for (const { interest, votes: v } of votes) {
    const why = excludedBy(interest, flags);
    if (why) {
      conflicts.push(`${cap(ACTIVITY_NAMES[interest] ?? interest)}: ${v === 1 ? 'хочет один участник' : `хотят ${v}`}, но у кого-то в группе ${why} — в план не ставим.`);
      continue;
    }
    if (interests.length < MAX_GROUP_INTERESTS) interests.push(interest);
    else conflicts.push(`${cap(ACTIVITY_NAMES[interest] ?? interest)} (${v}): не вошло — в плане не больше ${MAX_GROUP_INTERESTS} занятий, взяты набравшие больше голосов.`);
  }

  if (flags.limited > 0) conflicts.push('У кого-то в группе ограничена подвижность — план учитывает это для всех.');

  return {
    members: members.length,
    interests,
    votes,
    fitness,
    budget,
    seasickness: flags.seasickness > 0,
    limitedMobility: flags.limited > 0,
    children,
    conflicts,
  };
}
