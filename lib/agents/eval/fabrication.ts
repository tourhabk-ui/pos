/**
 * Детектор выдуманной конкретики в сгенерированном описании.
 *
 * Зачем отдельно от TSR. Регрессия Editor меряет успех как «текст не короче
 * 300 символов». Для вопроса «нужен ли в промпте блок запрета на выдумывание»
 * это негодная метрика: убрав запрет, модель СТАНЕТ писать охотнее и длиннее,
 * TSR вырастет — и замер покажет улучшение ровно там, где качество упало.
 * Мы бы сами себе доказали ложное, тем же способом, каким LLM-ревью доказывало
 * несуществующие дыры в booking-роуте.
 *
 * Поэтому у эксперимента два оракула: длина (умеет ли писать) и этот
 * (не сочиняет ли). Второй детерминированный: число с единицей измерения,
 * которого нет во входных данных, — выдумка. Никакой модели-судьи, никакого
 * «на мой взгляд».
 *
 * Ограничение честно: детектор ловит ЧИСЛОВУЮ конкретику. Выдуманные
 * качественные утверждения («безопасно для новичков», «брода нет») он не
 * видит — для них нужен судья или проверка по БД. Поэтому его показания —
 * нижняя оценка выдумок, а не полная.
 */

/** Единицы, которыми меряют то, что турист может проверить на своей шкуре. */
const UNIT = String.raw`(?:м|метр\w*|км|килрметр\w*|километр\w*|см|ч|час\w*|мин\w*|сут\w*|дн\w*|°|градус\w*|C|С|м\/с|кг|л)`;

/** Число с единицей: «1200 м», «3,5 км», «40 °C», «6 часов». */
const NUMERIC_CLAIM = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${UNIT}\b`, 'gi');

/** Голые числа тоже считаем, если рядом слово-подсказка про измеримое. */
const MEASURED_CONTEXT = /высот|глубин|длин|перепад|температур|расстояни|скорост|вес|площад|диаметр|координат|широт|долгот/i;

export interface FabricationReport {
  /** Числовые утверждения в сгенерированном тексте. */
  claims: string[];
  /** Из них те, которых нет во входных данных. */
  invented: string[];
  /** Есть ли выдуманная числовая конкретика. */
  hasFabrication: boolean;
}

/** Нормализация числа: 3,5 и 3.5 — одно и то же. */
function normalizeNumber(raw: string): string {
  return raw.replace(',', '.').replace(/\.0+$/, '');
}

/** Все числовые утверждения текста — как нормализованные числа. */
export function extractNumericClaims(text: string): string[] {
  const found = new Set<string>();

  for (const m of text.matchAll(NUMERIC_CLAIM)) {
    found.add(normalizeNumber(m[1]));
  }

  // Число без единицы, но в измерительном контексте: «высота 2741».
  for (const sentence of text.split(/[.!?\n]/)) {
    if (!MEASURED_CONTEXT.test(sentence)) continue;
    for (const m of sentence.matchAll(/\b(\d+(?:[.,]\d+)?)\b/g)) {
      found.add(normalizeNumber(m[1]));
    }
  }

  return [...found];
}

/**
 * Сверка: числа, которых нет во входе, модель взяла из головы.
 *
 * `sourceText` — всё, что модели дали: название, тип, имеющееся описание.
 * Годы и мелкие числа (до 10) не считаем: «два-три дня» и «XIX век» — это
 * обычная речь, а не поддельное измерение.
 */
export function detectFabrication(generated: string, sourceText: string): FabricationReport {
  const sourceNumbers = new Set(extractNumericClaims(sourceText));
  // Дополнительно разрешаем любое число, буквально встречающееся в источнике.
  for (const m of sourceText.matchAll(/\b(\d+(?:[.,]\d+)?)\b/g)) {
    sourceNumbers.add(normalizeNumber(m[1]));
  }

  const claims = extractNumericClaims(generated);
  const invented = claims.filter((c) => {
    if (sourceNumbers.has(c)) return false;
    const value = Number(c);
    if (!Number.isFinite(value)) return false;
    if (value <= 10) return false;                    // «2–3 дня», «5 человек»
    if (value >= 1000 && value <= 2100 && Number.isInteger(value)) {
      // Похоже на год — отдельный класс, числовым измерением не считаем.
      return false;
    }
    return true;
  });

  return { claims, invented, hasFabrication: invented.length > 0 };
}
