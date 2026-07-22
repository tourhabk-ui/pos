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

function collectSamples(arr: unknown[]): VerbalizedSample[] {
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
 * Спасение из ОБРЕЗАННОГО ответа: fast-провайдер может оборвать генерацию на
 * середине массива (лимит токенов) — тогда JSON.parse всего массива падает, но
 * первые ПОЛНЫЕ объекты `{"probability":…,"text":"…"}` целы. Реальный баг на
 * проде: сырой обрезанный VS-JSON сохранялся как описание маршрута. Достаём
 * каждый завершённый объект по отдельности и разэкранируем text через JSON.parse.
 */
function salvageSamples(text: string): VerbalizedSample[] {
  const out: VerbalizedSample[] = [];
  // Завершённый объект: probability-число, затем text-строка (учёт \" внутри).
  const objRe = /\{\s*"probability"\s*:\s*([0-9]*\.?[0-9]+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const prob = parseFloat(m[1]);
    let parsedText: string;
    try {
      parsedText = JSON.parse(`"${m[2]}"`) as string; // корректно снимает \n, \", \\
    } catch {
      continue;
    }
    parsedText = parsedText.trim();
    if (parsedText && Number.isFinite(prob)) out.push({ probability: prob, text: parsedText });
  }
  return out;
}

/**
 * Извлекает JSON-массив вариантов из ответа модели. Терпим к обёрткам:
 * ```json … ```, ведущий/хвостовой текст, а также к ОБРЕЗАННОМУ ответу
 * (генерация оборвалась на середине массива) — тогда спасаем завершённые
 * объекты по одному. Возвращает [] если извлечь нечего.
 */
export function parseVerbalizedSamples(raw: string): VerbalizedSample[] {
  if (!raw) return [];
  // Убираем markdown-ограждения, если есть.
  const noFence = raw.replace(/```(?:json)?/gi, '');
  // Салважим только попытку МАССИВА (есть '['): без него это не VS-ответ, а
  // случайный фрагмент — сохраняем прежний контракт «не-массив → []».
  const start = noFence.indexOf('[');
  if (start < 0) return [];
  const end = noFence.lastIndexOf(']');
  if (end > start) {
    try {
      const arr = JSON.parse(noFence.slice(start, end + 1));
      if (Array.isArray(arr)) {
        const parsed = collectSamples(arr);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      /* обрезанный/битый массив — падаем в salvage ниже */
    }
  }
  // Массив не распарсился целиком (частая причина — обрезка по токенам):
  // спасаем завершённые объекты из области после '['.
  return salvageSamples(noFence.slice(start));
}

/**
 * Похоже ли на (возможно битую) попытку VS-JSON: начинается с '[' и несёт
 * ключи "probability"/"text". Нужно вызывающим, чтобы НЕ сохранить сырой
 * VS-JSON как контент, когда распарсить/спасти ничего не удалось (это провал
 * генерации, а не описание).
 */
export function looksLikeVerbalizedJson(raw: string): boolean {
  if (!raw) return false;
  const s = raw.replace(/```(?:json)?/gi, '').trimStart();
  return s.startsWith('[') && /"probability"\s*:/.test(s) && /"text"\s*:/.test(s);
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
