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
export function parseDms(text: string | null): LatLng | null {
  if (!text) return null;

  // Секунды могут прийти отмеченными " (кавычка) ИЛИ ' (апостроф) — OCR
  // нередко распознаёт кавычку-секунду тем же символом, что и минуту
  // («52°50'26'N»), поэтому терминатор секунд принимает оба знака.
  const dms = text.match(
    /(\d{1,3})[°\s]+(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)['′"″]?\s*([NSns])\D+(\d{1,3})[°\s]+(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)['′"″]?\s*([EWew])/,
  );
  if (dms) {
    const [, latD, latM, latS, latH, lngD, lngM, lngS, lngH] = dms;
    const lat = toDecimal(latD, latM, latS, latH);
    const lng = toDecimal(lngD, lngM, lngS, lngH);
    return lat !== null && lng !== null ? { lat, lng } : null;
  }

  const decimal = text.match(/(\d{2,3}[.,]\d{3,})[,\s]+(\d{2,3}[.,]\d{3,})/);
  if (decimal) {
    const lat = parseFloat(decimal[1].replace(',', '.'));
    const lng = parseFloat(decimal[2].replace(',', '.'));
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  return null;
}

function toDecimal(d: string, m: string, s: string, hemi: string): number | null {
  const deg = parseFloat(d), min = parseFloat(m), sec = parseFloat(s);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  const value = deg + min / 60 + sec / 3600;
  const negative = hemi.toUpperCase() === 'S' || hemi.toUpperCase() === 'W';
  return negative ? -value : value;
}
