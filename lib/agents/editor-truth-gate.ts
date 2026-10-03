/**
 * Проверка правды перед записью описания Editor'ом (решение владельца 03.10:
 * «Editor не должен выдумывать, только правду»).
 *
 * До этого запреты жили только в промпте: «не придумывай числа», «не
 * выдумывай опасности», «своими знаниями о Камчатке пользоваться запрещено».
 * Результат не проверял никто — оба пути записи (прод `runEditor` и приёмник
 * раннера `/api/cron/editor-result`) сохраняли любой текст длиннее 40 знаков.
 * Послушание модели — не механизм (CLAUDE.md, §10.09: объявленное без
 * производителя и сторожа).
 *
 * Что проверяется — только то, что можно проверить детерминированно, по
 * ИСТОЧНИКУ, который ушёл в промпт (факты из базы + прежнее описание +
 * название):
 *
 *   1. голос: дневник от первого лица и «ощущения» (запах, тишина, «ты»)
 *      машина записать не может — наблюдения не было (`description-voice`);
 *   2. числа: каждое число в тексте обязано быть в источнике. Выдуманная
 *      высота, дистанция или «2–3 часа пешком» — ровно то, что чистили
 *      миграции 866 и 897;
 *   3. опасности: медведи, лавины, камнепад, брод, ледоруб — только если они
 *      есть в источнике. Ложная опасность и ложное «безопасно» одинаково
 *      меняют решение туриста идти или нет;
 *   4. рекламные эпитеты — промпт их запрещает, здесь это проверяется.
 *
 * Исходов три, как требует §4.0: `ok` — записать; `rejected` с причинами —
 * не записывать и сказать почему; если проверить нечем (источник пуст), сюда
 * запись не доходит вовсе — Editor не зовёт модель без фактов.
 *
 * Чего проверка НЕ умеет: выдуманный факт без чисел и без слов-опасностей
 * («тропа идёт через березняк») она пропустит. Это не «проверено на правду»,
 * а отсечение самых частых и самых дорогих видов выдумки.
 */

import { descriptionVoice } from '@/lib/places/description-voice';

export interface TruthVerdict {
  ok: boolean;
  /** Причины отказа — по-русски, для журнала и Telegram. Пусто при ok. */
  reasons: string[];
}

/**
 * Опасности и снаряжение безопасности. Основа слова — чтобы ловить падежи.
 * Список явный: слово попадает сюда, только если его выдумка меняет решение
 * туриста.
 */
export const HAZARD_STEMS: ReadonlyArray<{ stem: string; label: string }> = [
  { stem: 'медвед', label: 'медведи' },
  { stem: 'лавин', label: 'лавины' },
  { stem: 'камнепад', label: 'камнепад' },
  { stem: 'обвал', label: 'обвалы' },
  { stem: 'брод', label: 'брод' },
  { stem: 'сел', label: 'сели' },
  { stem: 'ледоруб', label: 'ледоруб' },
  { stem: 'кошк', label: 'кошки' },
  { stem: 'трещин', label: 'трещины' },
  { stem: 'сероводород', label: 'сероводород' },
  { stem: 'ожог', label: 'ожоги' },
  { stem: 'кипят', label: 'кипяток' },
  { stem: 'безопасн', label: 'оценка безопасности' },
  { stem: 'новичк', label: 'подходит новичкам' },
];

export const BANNED_EPITHETS: ReadonlyArray<string> = [
  'захватывающ', 'незабываем', 'уникальн', 'райск', 'must-see',
  'величествен', 'легендарн', 'потрясающ', 'волшебн', 'сказочн',
];

const L = '(?<![а-яёa-z])';

function hasStem(text: string, stem: string): boolean {
  // «сел» — только как отдельное слово/основа «сели», «селевой», не «посёлок»
  // и не «весело»: граница слова слева обязательна для всех основ.
  return new RegExp(`${L}${stem}`, 'iu').test(text);
}

/** Числа текста в нормальной форме: «2 741» → «2741», «3,5» → «3.5». */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
  for (const m of text.match(re) ?? []) {
    out.push(m.replace(/[  ]/g, '').replace(',', '.'));
  }
  return out;
}

/**
 * Число текста «есть в источнике», если оно совпадает с числом источника или
 * является его округлением по десятичным знакам (53.2 из 53.2037192). Целое
 * не совпадает с другим целым по префиксу: 27 ≠ 2741.
 */
function numberInSource(n: string, sourceNumbers: Set<string>): boolean {
  if (sourceNumbers.has(n)) return true;
  if (!n.includes('.')) return false;
  for (const s of sourceNumbers) {
    if (s.includes('.') && s.startsWith(n)) return true;
  }
  return false;
}

export function judgeGeneratedDescription(
  text: string,
  source: { facts: string[]; title: string; previous: string | null },
): TruthVerdict {
  const reasons: string[] = [];
  const sourceText = [source.title, ...source.facts, source.previous ?? ''].join('\n');

  const voice = descriptionVoice(text);
  if (voice.voice !== 'plain') {
    reasons.push(`голос «${voice.voice === 'diary' ? 'путевая заметка' : 'впечатление'}»: ${voice.markers.slice(0, 3).join(', ')}`);
  }

  const sourceNumbers = new Set(extractNumbers(sourceText));
  const invented = [...new Set(extractNumbers(text).filter((n) => !numberInSource(n, sourceNumbers)))];
  if (invented.length > 0) {
    reasons.push(`числа не из источника: ${invented.slice(0, 5).join(', ')}`);
  }

  const hazards = HAZARD_STEMS
    .filter((h) => hasStem(text, h.stem) && !hasStem(sourceText, h.stem))
    .map((h) => h.label);
  if (hazards.length > 0) {
    reasons.push(`безопасность не из источника: ${hazards.join(', ')}`);
  }

  const epithets = BANNED_EPITHETS.filter((e) => hasStem(text, e));
  if (epithets.length > 0) {
    reasons.push(`рекламные эпитеты: ${epithets.join(', ')}`);
  }

  return { ok: reasons.length === 0, reasons };
}
