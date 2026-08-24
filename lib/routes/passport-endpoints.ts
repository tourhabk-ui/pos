/**
 * Извлечение точек начала/конца из OCR-текста паспорта маршрута
 * (route_passport_ocr, migration 730) — чистая логика без сети/БД.
 *
 * Узкий, безопасный первый шаг: паспорт содержит структурированное поле
 * «Пункт начала / Пункт окончания» (иногда координатами, иногда названием
 * ориентира), которое пайплайн обогащения (lib/import/passport-fields.ts)
 * никогда не читал — тот вытаскивает только метаданные (дистанция,
 * сложность, опасности), не точки пути.
 *
 * Модель извлекает координату КАК ТЕКСТ (дословную цитату из документа),
 * а не как готовое decimal-число: арифметику DMS→decimal делает код
 * (`parseDms`), не LLM — модели плохо считают, и доверять им перевод
 * градусов/минут/секунд в десятичную дробь значило бы завести источник
 * молчаливой ошибки, которую нечем поймать.
 *
 * Повествовательное описание дня похода (§2.2 паспорта, промежуточные
 * точки маршрута) сюда НЕ входит — там риск, что модель придумает точку,
 * которой в тексте нет, выше, и это отдельная задача с отдельным дизайном.
 */

export const PASSPORT_ENDPOINTS_PROMPT = `Ты извлекаешь точки начала и конца маршрута из официального паспорта туристического маршрута на Камчатке.
Верни ТОЛЬКО JSON (без markdown-обрамления) строго в формате:
{
  "start": { "name": "название ориентира на русском или null", "coord_text": "координатная строка ДОСЛОВНО из текста или null" },
  "end": { "name": "название ориентира на русском или null", "coord_text": "координатная строка ДОСЛОВНО из текста или null" }
}
Правила:
- Ищи поля вида «Пункт начала», «Пункт окончания», «Начало маршрута», «Координаты начала/конца».
- coord_text — цитата символ в символ из документа (например «52°50'26"N 158°09'06"E» или «52.963036, 158.708946»). НЕ вычисляй сам, не округляй, не переводи в другой формат.
- Если в тексте нет координаты для точки — coord_text: null, а name бери из названия ориентира, если оно есть.
- Если нет ни координаты, ни названия — null и там, и там. НЕ выдумывай.`;

export interface PassportEndpoint {
  name: string | null;
  coord_text: string | null;
}

export interface PassportEndpoints {
  start: PassportEndpoint;
  end: PassportEndpoint;
}

function textOr(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, maxLen);
  return s.length > 0 ? s : null;
}

function endpointOf(v: unknown): PassportEndpoint {
  const obj = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return { name: textOr(obj.name, 200), coord_text: textOr(obj.coord_text, 200) };
}

/** Терпимый разбор ответа модели: вырезает JSON из возможного обрамления. */
export function parsePassportEndpoints(raw: string): PassportEndpoints | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  return { start: endpointOf(obj.start), end: endpointOf(obj.end) };
}

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * DMS ("52°50'26\"N 158°09'06\"E") или decimal ("52.963036, 158.708946") →
 * координата. Существующий parseCoords в lib/agents/visitkamchatka-importer.ts
 * несмотря на комментарий разбирает только decimal — не чинится здесь ради
 * другой задачи, пишется отдельно.
 *
 * Возвращает null на любой неразобранной или неполной строке: «не знаю»
 * лучше угаданной координаты (§4.0).
 */
interface Token { start: number; end: number; value: number }

function markTaken(taken: boolean[], start: number, end: number): void {
  for (let i = start; i < end; i++) taken[i] = true;
}
function isFree(taken: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (taken[i]) return false;
  return true;
}
function hemiSign(h: string): 1 | -1 {
  const u = h.toUpperCase();
  return (u === 'S' || u === 'W' || u === 'Ю' || u === 'З') ? -1 : 1;
}

/** Находит все непересекающиеся совпадения `re` вне уже занятых диапазонов. */
function collect(
  text: string, taken: boolean[], re: RegExp,
  toValue: (m: RegExpMatchArray) => number | null,
): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index as number;
    const end = start + m[0].length;
    if (!isFree(taken, start, end)) continue;
    const value = toValue(m);
    if (value === null) continue;
    out.push({ start, end, value });
    markTaken(taken, start, end);
  }
  return out;
}

/** Кавычка-секунда встречается и как " (типографская), и как ' (OCR путает с минутой). */
const SEC = `['′"″]?`;

/**
 * Реальные паспорта дают минимум пять форм одной и той же координаты:
 * DMS с полушарием до/после градусов, DDM (без секунд) до/после, decimal с
 * кириллической подписью («С.Ш.», «В.Д.») и голый decimal через `;`/`,`/
 * пробел. Одним регэкспом это не разобрать надёжно — находим каждую форму
 * ПО ОТДЕЛЬНОСТИ непересекающимися проходами, затем берём первые два по
 * порядку появления в тексте: широта у всех паспортов названа раньше
 * долготы.
 *
 * Порядок проходов важен. Префиксные формы («N53°...») идут ПЕРЕД
 * суффиксными («...N»), и буква полушария в префиксе стоит ВПЛОТНУЮ к
 * градусам, без пробела — иначе «...26'N 158°...» read как «N 158°...»:
 * суффикс ПЕРВОЙ координаты через пробел перехватывается как префикс
 * ВТОРОЙ. Обратная ошибка (суффикс жадно берёт префиксную букву второй
 * координаты) снята тем, что префиксные проходы уже забрали свои токены
 * раньше и пометили диапазон занятым.
 */
export function parseDms(text: string | null): LatLng | null {
  if (!text) return null;
  const taken: boolean[] = [];
  const tokens: Token[] = [];

  // DMS, полушарие ПЕРЕД, вплотную (N53°15'36")
  tokens.push(...collect(text, taken,
    new RegExp(`([NSEWnsew])(\\d{1,3})[°\\s]+(\\d{1,2})['′]\\s*(\\d{1,2}(?:\\.\\d+)?)${SEC}`, 'g'),
    (m) => {
      const deg = parseFloat(m[2]), min = parseFloat(m[3]), sec = parseFloat(m[4]);
      if (![deg, min, sec].every(Number.isFinite)) return null;
      return hemiSign(m[1]) * (deg + min / 60 + sec / 3600);
    }));

  // DDM (градусы + десятичные минуты, без секунд), полушарие ПЕРЕД (N53°10.51')
  tokens.push(...collect(text, taken,
    /([NSEWnsew])(\d{1,3})[°\s]+(\d{1,2}(?:\.\d+)?)['′]/g,
    (m) => {
      const deg = parseFloat(m[2]), min = parseFloat(m[3]);
      if (![deg, min].every(Number.isFinite)) return null;
      return hemiSign(m[1]) * (deg + min / 60);
    }));

  // DMS, полушарие ПОСЛЕ (52°50'26"N)
  tokens.push(...collect(text, taken,
    new RegExp(`(\\d{1,3})[°\\s]+(\\d{1,2})['′]\\s*(\\d{1,2}(?:\\.\\d+)?)${SEC}\\s*([NSEWnsew])`, 'g'),
    (m) => {
      const deg = parseFloat(m[1]), min = parseFloat(m[2]), sec = parseFloat(m[3]);
      if (![deg, min, sec].every(Number.isFinite)) return null;
      return hemiSign(m[4]) * (deg + min / 60 + sec / 3600);
    }));

  // DDM, полушарие ПОСЛЕ (53°10.51'N)
  tokens.push(...collect(text, taken,
    /(\d{1,3})[°\s]+(\d{1,2}(?:\.\d+)?)['′]\s*([NSEWnsew])/g,
    (m) => {
      const deg = parseFloat(m[1]), min = parseFloat(m[2]);
      if (![deg, min].every(Number.isFinite)) return null;
      return hemiSign(m[3]) * (deg + min / 60);
    }));

  // Decimal с кириллической подписью полушария (54,4362056 С.Ш.)
  tokens.push(...collect(text, taken,
    /(\d{1,3}[.,]\d{3,})\s*(С\.?\s*Ш\.?|Ю\.?\s*Ш\.?|В\.?\s*Д\.?|З\.?\s*Д\.?)/gi,
    (m) => {
      const v = parseFloat(m[1].replace(',', '.'));
      if (!Number.isFinite(v)) return null;
      const label = m[2].toUpperCase();
      return (label.startsWith('Ю') || label.startsWith('З')) ? -v : v;
    }));

  // Голый decimal без подписи (54,4674322; 160,18883). Порог 3+ знаков
  // после точки/запятой отсекает случайные короткие числа — координаты
  // Камчатки в паспортах приходят с 6-7 знаками.
  tokens.push(...collect(text, taken,
    /(\d{1,3}[.,]\d{3,})/g,
    (m) => {
      const v = parseFloat(m[1].replace(',', '.'));
      return Number.isFinite(v) ? v : null;
    }));

  tokens.sort((a, b) => a.start - b.start);
  if (tokens.length < 2) return null;
  return { lat: tokens[0].value, lng: tokens[1].value };
}
