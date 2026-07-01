import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gradeNameMatch, getGuardianContext } from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('gradeNameMatch (CRAG-lite relevance grading, Roitman §16.5.5)', () => {
  it('grades an exact name match as high confidence', () => {
    expect(gradeNameMatch('Толбачик', 'Толбачик')).toBe('high');
  });

  it('grades case/whitespace-insensitive matches as high confidence', () => {
    expect(gradeNameMatch('толбачик', '  Толбачик  ')).toBe('high');
  });

  it('grades a query fully covered by a longer candidate name as high confidence', () => {
    expect(gradeNameMatch('Авачинский', 'Авачинский вулкан')).toBe('high');
  });

  it('grades a candidate name fully covered by the query as high confidence', () => {
    expect(gradeNameMatch('Мутновский вулкан кратер', 'Мутновский вулкан')).toBe('high');
  });

  it('grades an unrelated short-substring collision as low confidence', () => {
    // ILIKE '%Толбачик%' can bind a short unrelated place containing a shared
    // substring — this must NOT be treated as a confident safety-data match.
    expect(gradeNameMatch('Толбачик', 'Толбачинский дол дальний кордон')).toBe('low');
  });

  it('grades no overlap at all as low confidence', () => {
    expect(gradeNameMatch('Курильское озеро', 'Авачинская бухта')).toBe('low');
  });

  it('grades empty query or candidate as low confidence', () => {
    expect(gradeNameMatch('', 'Толбачик')).toBe('low');
    expect(gradeNameMatch('Толбачик', '')).toBe('low');
  });

  it('does not treat short-word prefixes as a match (e.g. "г" must not match "гора"/"гейзер")', () => {
    expect(gradeNameMatch('г', 'гора')).toBe('low');
    expect(gradeNameMatch('г', 'гейзер')).toBe('low');
  });

  it('still grades an exact short word as high confidence', () => {
    expect(gradeNameMatch('юг', 'юг')).toBe('high');
  });

  it('grades Russian morphology (case-ending) variants as low confidence', () => {
    // "Авачинский" (м.р.) vs "Авачинская сопка" (ж.р.) — общий префикс рвётся
    // на последних буквах, это НЕ должно матчиться как high. Это ожидаемо:
    // getGuardianContext компенсирует такие случаи отдельно — surfacing
    // алерта с рамкой неуверенности, а не повышением confidence здесь.
    expect(gradeNameMatch('Авачинский', 'Авачинская сопка')).toBe('low');
  });
});

describe('getGuardianContext low-confidence handling', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDbFor(placeRow: Record<string, unknown> | null) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: placeRow ? [placeRow] : [] });
      if (sql.includes('FROM external_alerts')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM agent_knowledge')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('surfaces an active alert on a low-confidence match instead of dropping it silently', async () => {
    mockDbFor({
      name: 'Авачинская сопка', description: 'Действующий вулкан', location_type: 'volcano',
      lat: 53.25, lng: 158.83, hazard_types: ['thermal'], difficulty_level: 3, altitude_m: 2741,
      nearest_medical_km: 30, sat_communicator_required: true, capacity_per_day: 100,
      open_from_date: null, open_to_date: null, is_open: true, current_crowds: 5,
      active_alerts: null, recommender_status: 'yellow',
      alert_message: 'Повышенная сейсмическая активность', alert_severity: 2, tourists_today: 10,
    });

    const ctx = await getGuardianContext('Авачинский');

    expect(ctx).toContain('неточное совпадение');
    expect(ctx).toContain('Повышенная сейсмическая активность'); // алерт не потерян
    expect(ctx).not.toContain('2741'); // высота вероятно-не-того места не должна выдаваться как факт
    expect(ctx).not.toContain('30 км'); // расстояние до медпомощи — тоже не факт про запрошенное место
  });

  it('omits the hedge tail entirely when there is no alert for the low-confidence place', async () => {
    mockDbFor({
      name: 'Толбачинский дол дальний кордон', description: 'Кордон', location_type: 'other',
      lat: null, lng: null, hazard_types: null, difficulty_level: null, altitude_m: null,
      nearest_medical_km: null, sat_communicator_required: null, capacity_per_day: null,
      open_from_date: null, open_to_date: null, is_open: null, current_crowds: null,
      active_alerts: null, recommender_status: null, alert_message: null, alert_severity: null,
      tourists_today: null,
    });

    const ctx = await getGuardianContext('Толбачик');

    expect(ctx).toContain('неточное совпадение');
    expect(ctx).not.toContain('алерт');
  });

  it('returns full safety facts unhedged for a high-confidence match', async () => {
    mockDbFor({
      name: 'Толбачик', description: 'Действующий вулкан на Камчатке', location_type: 'volcano',
      lat: 55.83, lng: 160.33, hazard_types: ['thermal'], difficulty_level: 4, altitude_m: 3085,
      nearest_medical_km: 200, sat_communicator_required: true, capacity_per_day: 50,
      open_from_date: null, open_to_date: null, is_open: true, current_crowds: 2,
      active_alerts: null, recommender_status: 'green', alert_message: null, alert_severity: null,
      tourists_today: 3,
    });

    const ctx = await getGuardianContext('Толбачик');

    expect(ctx).not.toContain('неточное совпадение');
    expect(ctx).toContain('3085');
    expect(ctx).toContain('200 км');
  });
});
