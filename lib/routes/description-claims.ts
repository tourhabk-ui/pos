/**
 * lib/routes/description-claims.ts — что описание, написанное моделью,
 * утверждает сверх данных, по которым его писали (14.10).
 *
 * Повод — слово владельца «3 да»: агенту описаний маршрутов поставить ту же
 * проверку, что заметкам Кузьмича (lib/kuzmich/review-claims). Агент
 * (`enrichDescriptions`, app/api/admin/enrich-routes) получает только
 * название, тип и прежнее короткое описание и пишет 300–500 знаков. Отсюда
 * «Тупикин ключ — водопад в долине реки Паратунка» у эко-тропы в Эссо, за
 * пятьсот километров от Паратунки: модель достроила место по названию.
 *
 * Улики (не приговор, как в review-claims):
 *   diary, number_not_in_data, hazard_not_in_data — те же, что у заметок;
 *   place_name_not_in_data — имя собственное посреди предложения
 *     («Паратунка», «Петропавловска», «Красную книгу»), которого нет в
 *     данных: писатель знает о месте только название, и любое другое имя —
 *     догадка о том, где место и с чем рядом.
 *
 * Имя в начале предложения не судится: там с заглавной пишется всё. Имя
 * края и страны («Камчатка», «Россия») — не улика.
 */

import { reviewClaims, type ReviewFlag } from '@/lib/kuzmich/review-claims';

export type DescriptionFlag = ReviewFlag | 'place_name_not_in_data';

export interface DescriptionFacts {
  /** Всё, что о месте или маршруте записано и было у писателя: название, прежнее описание, поля. */
  texts: ReadonlyArray<string | null | undefined>;
  /** Опасности, которые можно произносить как факт, — ключи HAZARDS. */
  hazardCodes?: readonly string[];
}

export interface DescriptionVerdict {
  flags: DescriptionFlag[];
  numbers: string[];
  hazards: string[];
  /** Имена без опоры — как стоят в тексте. */
  names: string[];
}

/** Основа слова для сверки имён: «Паратунка» и «Паратунским» — одно имя. */
function stem(word: string): string {
  return word.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').slice(0, 5);
}

/** Имя края и страны в описаниях Камчатки — не догадка о месте. */
const COMMON_STEMS = new Set(['камча', 'росси']);

const CAPITALIZED = /(?<![А-ЯЁа-яё])[А-ЯЁ][а-яё]{3,}(?:-[А-ЯЁа-яё][а-яё]+)?/g;

/** Имена собственные не в начале предложения. */
function midSentenceNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CAPITALIZED)) {
    const before = text.slice(0, m.index).replace(/[\s«"„(—–-]+$/u, '');
    if (before === '' || /[.!?…:]$/.test(before)) continue;
    out.push(m[0]);
  }
  return out;
}

export function descriptionClaims(text: string, facts: DescriptionFacts): DescriptionVerdict {
  const data = facts.texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '').join('\n');
  const base = reviewClaims(text, { description: data, hazardCodes: facts.hazardCodes ?? [], altitudeM: null });

  const known = new Set<string>();
  for (const w of data.match(/[А-ЯЁа-яё]{4,}/g) ?? []) known.add(stem(w));
  const names = [...new Set(midSentenceNames(text).filter((n) => {
    const s = stem(n.split('-')[0]);
    return !COMMON_STEMS.has(s) && !known.has(s);
  }))];

  const flags: DescriptionFlag[] = [...base.flags];
  if (names.length > 0) flags.push('place_name_not_in_data');
  return { flags, numbers: base.numbers, hazards: base.hazards, names };
}
