/**
 * Извлечение структурных полей карточки маршрута из OCR-markdown паспорта
 * (route_passport_ocr, migration 730) — чистая логика без сети/БД.
 *
 * Промпт — расширение уже проверенного в scripts/import-route-passports.ts
 * («нет данных → null, НЕ выдумывай»). Здесь дополнительно тянем hazards,
 * equipment, flora_fauna, accessibility, park_name — прямо в поля §10.
 *
 * Правило безопасности: парсер только предлагает значения; runner пишет их
 * ТОЛЬКО в пустые поля маршрута (кураторские данные не затираются).
 */

export const PASSPORT_EXTRACT_PROMPT = `Ты извлекаешь данные из официального паспорта туристического маршрута на Камчатке.
Верни ТОЛЬКО JSON (без markdown-обрамления) строго в формате:
{
  "distance_km": число или null,
  "elevation_gain_m": целое или null,
  "duration_hours": число или null,
  "duration_days": целое или null,
  "difficulty": "easy" | "medium" | "hard" | "expert" | null,
  "season": "summer" | "winter" | "all" | null,
  "route_type": "radial" | "linear" | "loop" | null,
  "mchs_registration_required": true | false | null,
  "hazards": ["конкретные опасности маршрута на русском"] или [],
  "equipment": ["необходимое снаряжение на русском"] или [],
  "flora_fauna": "краткое описание флоры и фауны на маршруте" или null,
  "accessibility": "доступность/как добраться/транспорт" или null,
  "park_name": "название природного парка/заповедника" или null
}
Правила:
- Если данных в тексте нет — null или пустой массив. НЕ выдумывай.
- hazards и equipment — короткие пункты (2-5 слов каждый), не предложения.
- difficulty: категория 1-2 → easy, 3 → medium, 4 → hard, 5+ → expert.
- route_type: радиальный → radial, линейный → linear, кольцевой → loop.`;

export interface PassportFields {
  distance_km: number | null;
  elevation_gain_m: number | null;
  duration_hours: number | null;
  duration_days: number | null;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert' | null;
  season: 'summer' | 'winter' | 'all' | null;
  route_type: 'radial' | 'linear' | 'loop' | null;
  mchs_registration_required: boolean | null;
  hazards: string[];
  equipment: string[];
  flora_fauna: string | null;
  accessibility: string | null;
  park_name: string | null;
}

const DIFFICULTY = new Set(['easy', 'medium', 'hard', 'expert']);
const SEASON = new Set(['summer', 'winter', 'all']);
const ROUTE_TYPE = new Set(['radial', 'linear', 'loop']);

function posNum(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}
function posInt(v: unknown, max: number): number | null {
  const n = posNum(v, max);
  return n === null ? null : Math.round(n);
}
function enumOr<T extends string>(v: unknown, set: Set<string>): T | null {
  return typeof v === 'string' && set.has(v) ? (v as T) : null;
}
function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
function textOr(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, maxLen);
  return s.length >= 3 ? s : null;
}

/** Терпимый разбор ответа LLM: вырезает JSON из возможного обрамления. */
export function parsePassportFields(raw: string): PassportFields | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    distance_km: posNum(obj.distance_km, 2000),
    elevation_gain_m: posInt(obj.elevation_gain_m, 10000),
    duration_hours: posNum(obj.duration_hours, 2000),
    duration_days: posInt(obj.duration_days, 90),
    difficulty: enumOr(obj.difficulty, DIFFICULTY),
    season: enumOr(obj.season, SEASON),
    route_type: enumOr(obj.route_type, ROUTE_TYPE),
    mchs_registration_required: typeof obj.mchs_registration_required === 'boolean' ? obj.mchs_registration_required : null,
    hazards: strList(obj.hazards, 12, 80),
    equipment: strList(obj.equipment, 20, 80),
    flora_fauna: textOr(obj.flora_fauna, 1000),
    accessibility: textOr(obj.accessibility, 1000),
    park_name: textOr(obj.park_name, 120),
  };
}

/** Текущее (кураторское) состояние заполняемых полей маршрута. */
export interface ExistingRouteFields {
  distance_km: number | null;
  elevation_gain_m: number | null;
  duration_hours: number | null;
  duration_days: number | null;
  difficulty: string | null;
  season: string | null;
  route_type: string | null;
  mchs_registration_required: boolean | null;
  hazards: string[] | null;
  equipment: string[] | null;
  flora_fauna: string | null;
  accessibility: string | null;
  park_name: string | null;
}

const isEmptyText = (v: string | null) => v === null || v.trim() === '';
const isEmptyArr = (v: string[] | null) => v === null || v.length === 0;

/**
 * Строит UPDATE только для ПУСТЫХ полей маршрута — кураторские значения
 * никогда не перезаписываются. Возвращает `null`, если писать нечего.
 */
export function buildRouteUpdate(
  extracted: PassportFields,
  existing: ExistingRouteFields,
): { sets: string[]; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (existing.distance_km === null && extracted.distance_km !== null) add('distance_km', extracted.distance_km);
  if (existing.elevation_gain_m === null && extracted.elevation_gain_m !== null) add('elevation_gain_m', extracted.elevation_gain_m);
  if (existing.duration_hours === null && extracted.duration_hours !== null) add('duration_hours', extracted.duration_hours);
  if (existing.duration_days === null && extracted.duration_days !== null) add('duration_days', extracted.duration_days);
  if (isEmptyText(existing.difficulty) && extracted.difficulty !== null) add('difficulty', extracted.difficulty);
  if (isEmptyText(existing.season) && extracted.season !== null) add('season', extracted.season);
  if (isEmptyText(existing.route_type) && extracted.route_type !== null) add('route_type', extracted.route_type);
  if (existing.mchs_registration_required === null && extracted.mchs_registration_required !== null) add('mchs_registration_required', extracted.mchs_registration_required);
  if (isEmptyArr(existing.hazards) && extracted.hazards.length > 0) add('hazards', extracted.hazards);
  if (isEmptyArr(existing.equipment) && extracted.equipment.length > 0) add('equipment', extracted.equipment);
  if (isEmptyText(existing.flora_fauna) && extracted.flora_fauna !== null) add('flora_fauna', extracted.flora_fauna);
  if (isEmptyText(existing.accessibility) && extracted.accessibility !== null) add('accessibility', extracted.accessibility);
  if (isEmptyText(existing.park_name) && extracted.park_name !== null) add('park_name', extracted.park_name);

  return sets.length > 0 ? { sets, params } : null;
}
