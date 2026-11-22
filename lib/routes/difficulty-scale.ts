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

/**
 * Сложность в любом виде записи — кодом. В базе она бывает кодом импорта
 * (`easy`, `moderate`), словом паспорта («сложный», «средней сложности») или
 * правкой миграции (1493: `extreme`). Не узнали — null, а не «лёгкий»
 * (22.11: карточка каталога подставляла «Лёгкий» на любую неизвестную и на
 * «экстремальный» — Ключевская сопка в каталоге выглядела лёгкой).
 */
export function difficultyCode(raw: unknown): DifficultyLevel | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase().replace(/ё/g, 'е');
  if (!t) return null;
  if (t === 'easy' || t === 'medium' || t === 'hard' || t === 'extreme') return t;
  if (t === 'moderate') return 'medium';
  if (t.startsWith('экстрем')) return 'extreme';
  if (t.startsWith('лег')) return 'easy';
  if (t.startsWith('сред')) return 'medium';
  if (t.startsWith('сложн')) return 'hard';
  return null;
}

/**
 * Записи, которые фильтр каталога считает одной ступенью. «Сложные» включают
 * экстремальные: человек, отбирающий трудное, их ищет тоже.
 */
export const DIFFICULTY_FILTER_SPELLINGS: Record<'easy' | 'medium' | 'hard', string[]> = {
  easy: ['easy', 'лёгкий', 'легкий'],
  medium: ['medium', 'moderate', 'средний', 'средней сложности'],
  hard: ['hard', 'сложный', 'extreme', 'экстремальный'],
};
