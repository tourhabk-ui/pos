/**
 * Verbalized Sampling (VS) — стратегия промптинга против mode collapse
 * (Zhang et al., Stanford, arXiv:2510.01171).
 *
 * Идея: вместо «дай ответ» просим «дай N вариантов с их вероятностями». Модель
 * после alignment вынуждена описать распределение из pre-training, а не схлопнуться
 * в один шаблонный ответ. Разнообразие ↑ в 1.6–2.1× без дообучения.
 *
 * Применяем к контент-генерации (Editor описаний), где разнообразие полезно.
 * НЕ применять к safety-ответам Кузьмича — там типичность (осторожность) желательна.
 *
 * Чистый модуль (парсинг/выбор), без сети — тестируется на фикстурах.
 */

/** ~30 слов, добавляемые к задаче, чтобы запросить распределение вместо одного ответа. */
export function verbalizedInstruction(n = 3): string {
  return (
    `Сгенерируй ${n} РАЗНЫХ варианта ответа с вероятностью каждого ` +
    `(число 0–1, насколько типичен и ожидаем этот вариант). ` +
    `Не повторяй формулировки между вариантами. ` +
    `Верни ТОЛЬКО валидный JSON-массив вида ` +
    `[{"probability": число, "text": "текст ответа"}] — без пояснений и markdown.`
  );
}

export interface VerbalizedSample {
  probability: number;
  text: string;
}

/**
 * Извлекает JSON-массив вариантов из ответа модели. Терпим к обёрткам:
 * ```json … ```, ведущий/хвостовой текст. Возвращает [] если распарсить нельзя.
 */
export function parseVerbalizedSamples(raw: string): VerbalizedSample[] {
  if (!raw) return [];
  // Убираем markdown-ограждения, если есть.
  const noFence = raw.replace(/```(?:json)?/gi, '');
  // Берём первый '[' … последний ']' — массив может быть окружён текстом.
  const start = noFence.indexOf('[');
  const end = noFence.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(noFence.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: VerbalizedSample[] = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      const probRaw = rec.probability;
      const prob = typeof probRaw === 'number' ? probRaw
        : typeof probRaw === 'string' ? parseFloat(probRaw)
        : NaN;
      if (text && Number.isFinite(prob)) out.push({ probability: prob, text });
    }
  }
  return out;
}

/**
 * Выбирает наименее типичный (низкая вероятность) вариант приемлемого качества —
 * в этом и состоит выигрыш VS в разнообразии. Фильтр по минимальной длине отсекает
 * вырожденные короткие варианты. Порог вероятности отсекает мусорные (prob≈0).
 * Возвращает null, если ни один вариант не прошёл фильтр — caller делает fallback.
 */
export function pickLeastTypical(
  samples: VerbalizedSample[],
  minLen: number,
  probFloor = 0.05,
): string | null {
  const valid = samples.filter(s => s.text.length >= minLen && s.probability >= probFloor);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.probability - b.probability);
  return valid[0].text;
}
