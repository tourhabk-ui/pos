/**
 * lib/routes/difficulty-scale.ts — сложность маршрута из его чисел.
 *
 * Пороги утверждены владельцем 21.08 («го» на шкалу): сложность считается
 * из набора высоты и дистанции — ровно так её выводят зрелые аутдор-платформы,
 * когда оператор её не указал. Каскад: первый уровень, в чьи ОБА порога
 * маршрут укладывается; не уложился ни в один — extreme.
 *
 * Шкала — суждение, поэтому:
 *   - живёт ОДНОЙ константой (второй список порогов в другом файле — это
 *     вторая шкала, и они разойдутся);
 *   - вычисленное значение помечается difficulty_source = 'computed_v1'
 *     (миграция 895): «оператор сказал» и «платформа посчитала» — разные
 *     состояния, и карточка вправе их различать;
 *   - считается только когда известны ОБА числа — из одного угадывать нельзя.
 */

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'extreme';

export const DIFFICULTY_SCALE: ReadonlyArray<{
  level: Exclude<DifficultyLevel, 'extreme'>;
  maxGainM: number;
  maxKm: number;
}> = [
  { level: 'easy', maxGainM: 400, maxKm: 10 },
  { level: 'medium', maxGainM: 1000, maxKm: 25 },
  { level: 'hard', maxGainM: 2000, maxKm: 50 },
];

export function computeDifficulty(gainM: number, distanceKm: number): DifficultyLevel {
  for (const step of DIFFICULTY_SCALE) {
    if (gainM < step.maxGainM && distanceKm < step.maxKm) return step.level;
  }
  return 'extreme';
}
