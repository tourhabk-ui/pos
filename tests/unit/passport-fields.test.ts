import { describe, it, expect } from 'vitest';
import {
  parsePassportFields,
  buildRouteUpdate,
  type ExistingRouteFields,
} from '@/lib/import/passport-fields';

const EMPTY_EXISTING: ExistingRouteFields = {
  distance_km: null, elevation_gain_m: null, duration_hours: null, duration_days: null,
  difficulty: null, season: null, route_type: null, mchs_registration_required: null,
  hazards: null, equipment: null, flora_fauna: null, accessibility: null, park_name: null,
};

describe('parsePassportFields', () => {
  it('разбирает валидный JSON, санитизируя типы и энумы', () => {
    const raw = `Вот данные:
    {
      "distance_km": 12.5, "elevation_gain_m": 700, "duration_hours": 6, "duration_days": 1,
      "difficulty": "hard", "season": "summer", "route_type": "radial",
      "mchs_registration_required": true,
      "hazards": ["камнепад", "термальные поля", "камнепад"],
      "equipment": ["ботинки", "палки"],
      "flora_fauna": "Каменная берёза, бурый медведь.",
      "accessibility": "Заброска вахтовкой от Елизово.",
      "park_name": "Налычево"
    }`;
    const f = parsePassportFields(raw)!;
    expect(f.distance_km).toBe(12.5);
    expect(f.elevation_gain_m).toBe(700);
    expect(f.difficulty).toBe('hard');
    expect(f.route_type).toBe('radial');
    expect(f.mchs_registration_required).toBe(true);
    expect(f.hazards).toEqual(['камнепад', 'термальные поля']); // дедуп
    expect(f.park_name).toBe('Налычево');
  });

  it('невалидный энум и отрицательные числа → null', () => {
    const f = parsePassportFields('{"difficulty":"суперхард","distance_km":-5,"season":"осень","route_type":"zigzag"}')!;
    expect(f.difficulty).toBeNull();
    expect(f.distance_km).toBeNull();
    expect(f.season).toBeNull();
    expect(f.route_type).toBeNull();
  });

  it('строковое число парсится, короткий текст отбрасывается', () => {
    const f = parsePassportFields('{"distance_km":"18.2","flora_fauna":"ок"}')!;
    expect(f.distance_km).toBe(18.2);
    expect(f.flora_fauna).toBeNull(); // <3 символов
  });

  it('не-JSON → null', () => {
    expect(parsePassportFields('модель отказалась отвечать')).toBeNull();
  });

  it('отсутствующие поля становятся null / пустым массивом', () => {
    const f = parsePassportFields('{"distance_km": 10}')!;
    expect(f.hazards).toEqual([]);
    expect(f.equipment).toEqual([]);
    expect(f.flora_fauna).toBeNull();
  });
});

describe('buildRouteUpdate — только пустые поля, без затирания кураторских', () => {
  it('заполняет все пустые поля', () => {
    const f = parsePassportFields(JSON.stringify({
      distance_km: 12, difficulty: 'medium', hazards: ['камнепад'], park_name: 'Налычево',
    }))!;
    const upd = buildRouteUpdate(f, EMPTY_EXISTING)!;
    const cols = upd.sets.map((s) => s.split(' = ')[0]);
    expect(cols).toContain('distance_km');
    expect(cols).toContain('difficulty');
    expect(cols).toContain('hazards');
    expect(cols).toContain('park_name');
    expect(upd.params).toContain('Налычево');
  });

  it('НЕ перезаписывает уже заполненные кураторские поля', () => {
    const existing: ExistingRouteFields = {
      ...EMPTY_EXISTING,
      distance_km: 99, difficulty: 'expert', hazards: ['лавины'], park_name: 'Ключевской',
    };
    const f = parsePassportFields(JSON.stringify({
      distance_km: 12, difficulty: 'medium', hazards: ['камнепад'], park_name: 'Налычево',
      season: 'summer', // это поле пустое — его можно записать
    }))!;
    const upd = buildRouteUpdate(f, existing)!;
    const cols = upd.sets.map((s) => s.split(' = ')[0]);
    expect(cols).not.toContain('distance_km');
    expect(cols).not.toContain('difficulty');
    expect(cols).not.toContain('hazards');
    expect(cols).not.toContain('park_name');
    expect(cols).toEqual(['season']); // только пустое поле
  });

  it('пустой массив hazards в существующем считается пустым и заполняется', () => {
    const existing: ExistingRouteFields = { ...EMPTY_EXISTING, hazards: [] };
    const f = parsePassportFields(JSON.stringify({ hazards: ['камнепад', 'медведи'] }))!;
    const upd = buildRouteUpdate(f, existing)!;
    expect(upd.sets.map((s) => s.split(' = ')[0])).toContain('hazards');
  });

  it('нечего писать (всё заполнено или извлечено пусто) → null', () => {
    expect(buildRouteUpdate(parsePassportFields('{}')!, EMPTY_EXISTING)).toBeNull();
    const full: ExistingRouteFields = {
      distance_km: 1, elevation_gain_m: 1, duration_hours: 1, duration_days: 1,
      difficulty: 'easy', season: 'all', route_type: 'loop', mchs_registration_required: false,
      hazards: ['x'], equipment: ['y'], flora_fauna: 'z', accessibility: 'w', park_name: 'p',
    };
    const f = parsePassportFields(JSON.stringify({ distance_km: 5, hazards: ['a'] }))!;
    expect(buildRouteUpdate(f, full)).toBeNull();
  });

  it('placeholder $N в SET совпадает с позицией параметра', () => {
    const f = parsePassportFields(JSON.stringify({ distance_km: 12, season: 'summer' }))!;
    const upd = buildRouteUpdate(f, EMPTY_EXISTING)!;
    upd.sets.forEach((s, i) => expect(s).toContain(`$${i + 1}`));
    expect(upd.params).toHaveLength(upd.sets.length);
  });
});
