import { describe, it, expect } from 'vitest';
import { seasonLabel, routeFacts } from '@/lib/ai/route-knowledge';
import { seasonFactsBlock, SEASON_FACTS } from '@/lib/kuzmich/season-facts';
import { KUZMICH_SYSTEM } from '@/lib/kuzmich/core';

describe('сезон маршрута по-русски', () => {
  it("'all' не печатается, enum переведён, текст как есть", () => {
    expect(seasonLabel('all')).toBeNull();
    expect(seasonLabel('summer')).toBe('летний');
    expect(seasonLabel('winter')).toBe('зимний');
    expect(seasonLabel('конец мая – конец сентября')).toBe('конец мая – конец сентября');
    const base = { difficulty: null, distance_km: null, elevation_gain_m: null, duration_hours: null, hazards: null, equipment: null, mchs_registration_required: null, mchs_phone: null };
    expect(routeFacts({ ...base, season: 'all' } as never).join(' ')).not.toContain('сезон');
  });
});

describe('сезон Долины гейзеров — из kronoki.ru', () => {
  it('блок для вопроса о Долине с источником', () => {
    const b = seasonFactsBlock('В какие месяцы открыта Долина гейзеров?');
    expect(b).toContain('конец мая – конец сентября');
    expect(b).toContain('kronoki.ru');
    expect(seasonFactsBlock('Паратунка')).toBe('');
    for (const f of SEASON_FACTS) expect(f.sources.every((s) => s.startsWith('https://'))).toBe(true);
  });
  it('в промпте нет сезона Долины по памяти', () => {
    expect(KUZMICH_SYSTEM).not.toMatch(/Вертолётные туры: июнь–сентябрь/);
    expect(KUZMICH_SYSTEM).toContain('СЕЗОН ПОСЕЩЕНИЯ');
  });
});
