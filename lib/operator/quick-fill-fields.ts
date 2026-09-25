/**
 * Какие поля тура заполняются «быстро» — одной строкой на экране полноты.
 *
 * Один список на клиент и сервер (25.09): до этого экран показывал кнопку
 * у фото, сезона, состава, снаряжения и координат, а сервер их отвергал с
 * 400. Поля не из списка ведут в редактор тура — там у них нормальные формы.
 */
export const QUICK_FILL_FIELDS = [
  'title', 'description', 'short_description',
  'base_price', 'price_old', 'price_unit',
  'location_type', 'activity_type', 'location_name',
  'difficulty', 'duration_hours', 'duration_type',
] as const;

export type QuickFillField = (typeof QUICK_FILL_FIELDS)[number];

export function isQuickFillField(field: string): field is QuickFillField {
  return (QUICK_FILL_FIELDS as readonly string[]).includes(field);
}

const ENUMS: Partial<Record<QuickFillField, readonly string[]>> = {
  price_unit: ['per_tour', 'per_person', 'per_day_per_person'],
  location_type: ['volcano', 'hot_spring', 'bay', 'lake', 'mountain', 'river', 'geyser', 'other'],
  activity_type: ['trekking', 'thermal', 'boat_trip', 'rafting', 'fishing', 'bears', 'helicopter', 'jeep', 'other'],
  difficulty: ['easy', 'medium', 'hard', 'expert'],
  duration_type: ['day', 'multi_day'],
};
const NUMERIC: readonly QuickFillField[] = ['base_price', 'price_old', 'duration_hours'];

/** Значение для записи или текст ошибки для оператора. */
export function parseQuickFillValue(field: QuickFillField, raw: unknown): { ok: true; value: string | number } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!text) return { ok: false, error: 'Заполните значение' };
  if (NUMERIC.includes(field)) {
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Нужно положительное число' };
    return { ok: true, value: n };
  }
  const allowed = ENUMS[field];
  if (allowed && !allowed.includes(text)) return { ok: false, error: `Допустимо: ${allowed.join(', ')}` };
  if (text.length > (field === 'description' ? 2000 : 500)) return { ok: false, error: 'Слишком длинное значение' };
  return { ok: true, value: text };
}
