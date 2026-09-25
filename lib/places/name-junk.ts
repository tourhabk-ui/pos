/**
 * Подозрение «это не место, а экскурсия» — по названию и виду (25.09).
 *
 * Сверка MCP 25.09 нашла в справочнике мест запись «Долина гейзеров.
 * Курильское озеро. Вулканы Горелый и Авача» с видом `volcano` и описанием
 * одной Долины гейзеров: название экскурсии, попавшее в таблицу мест. У такой
 * записи одна точка на карте при четырёх объектах, и она всплывает в поиске
 * по каждому из них.
 *
 * Здесь — только ПОДОЗРЕНИЕ с причиной словами, не приговор: решает человек,
 * и прячется запись миграцией с причиной, а не удаляется (§4.1: без источника
 * не правят — прячут). Урок 23.08: автомат по имени испортил бы 21 верную
 * запись из 24, поэтому признаки узкие и каждый назван.
 */

export interface JunkSuspect {
  reasons: string[];
}

/** Сокращения, после которых точка — не конец предложения: «о. Беринга», «р. Камчатка». */
const ABBREV = /(^|[\s(«"])(о|оз|р|г|с|п|пос|им|ст|м|вдп|влк|б|хр|пер|ист|руч|пгт|ул|св)\.$/i;

/** Части названия, разделённые концом предложения («Долина гейзеров. Курильское озеро»). */
export function sentenceParts(name: string): string[] {
  const parts: string[] = [];
  let cur = '';
  const tokens = name.split(/(\.\s+)/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\.\s+$/.test(t)) {
      const next = tokens[i + 1] ?? '';
      if (!ABBREV.test(cur.trim() + '.') && /^[А-ЯЁA-Z«"]/.test(next)) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += t;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

/**
 * Вид по первому слову названия. Только однозначные слова: «гора» и «сопка»
 * бывают и вулканом, поэтому их здесь нет — несовпадение по ним ложное.
 */
const WORD_TYPE: Array<[RegExp, string[]]> = [
  // «Озеро», «Озёра», но не «Озерновские» — прилагательное (перепись 25.09).
  [/^оз[её]р[оа](\s|$)/i, ['lake']],
  [/^водопад/i, ['waterfall']],
  [/^гейзер/i, ['geyser']],
  [/^бухт/i, ['bay']],
  [/^мыс\b/i, ['cape']],
  [/^рек[аи]\b/i, ['river']],
  [/^перевал/i, ['pass']],
  [/^долин/i, ['valley']],
  [/^каньон/i, ['canyon']],
  [/^пляж/i, ['beach']],
];

export function typeMismatch(name: string, type: string): string | null {
  const first = name.trim().toLowerCase();
  for (const [re, types] of WORD_TYPE) {
    if (re.test(first)) {
      return types.includes(type) ? null : `название начинается как «${first.split(/\s+/)[0]}», а вид записан «${type}»`;
    }
  }
  return null;
}

export function nameJunkSuspect(name: string, type: string): JunkSuspect | null {
  const reasons: string[] = [];
  const parts = sentenceParts(name);
  if (parts.length >= 2) reasons.push(`в названии ${parts.length} части через точку: ${parts.map((p) => `«${p}»`).join(', ')}`);
  if (/\s\+\s|\s\/\s/.test(name)) reasons.push('объекты через «+» или «/»');
  if ((name.match(/,/g) ?? []).length >= 2) reasons.push('перечисление через запятые');
  if (name.length > 70) reasons.push(`длинное название (${name.length} знаков)`);
  const mm = typeMismatch(name, type);
  if (mm) reasons.push(mm);
  return reasons.length > 0 ? { reasons } : null;
}
