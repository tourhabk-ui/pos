/**
 * Editor пишет из фактов, а не вокруг названия.
 *
 * Владелец 23.08: «Editor не сверяется с фактами о месте, часто сочиняет».
 * Причина была не в модели. Запрос брал четыре поля (id, title, description,
 * category), а промпт требовал «не меньше 120 слов» и прямо разрешал
 * «опираться на свои общие знания». Просить объём, не дав источника, — заказ
 * на выдумку (§4.0). Третьей квотой работал MIN_GENERATION_LENGTH = 100:
 * честный короткий ответ считался ПРОВАЛОМ и возвращался на следующий прогон,
 * пока не будет написан подлиннее — то есть пока не будет дописан выдумкой.
 *
 * Здесь проверяется поведение, а не формулировки: какие факты уходят в промпт,
 * что происходит при их отсутствии и не вернулись ли квоты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFacts, type RouteRow } from '@/lib/agents/editor';

const SRC = readFileSync('lib/agents/editor.ts', 'utf8');

const bare: RouteRow = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Безымянная точка', description: null, category: null,
  kind: null, lat: null, lng: null, location_type: null, activity_type: null,
  zone: null, source_name: null,
  altitude_m: null, terrain_type: null, hazard_types: null,
  difficulty_level: null, nearest_medical_km: null,
  distance_km: null, elevation_gain_m: null, duration_hours: null,
  season: null, route_type: null, hazards: null, equipment: null, park_name: null,
};

describe('в промпт уходит то, что есть, и только оно', () => {
  it('пустая запись даёт пустой список фактов', () => {
    expect(buildFacts(bare)).toEqual([]);
  });

  it('отсутствующее поле НЕ упоминается вовсе', () => {
    // «Высота: неизвестно» — это приглашение придумать высоту.
    const facts = buildFacts({ ...bare, altitude_m: 2741 });
    expect(facts.join(' ')).toContain('2741');
    expect(facts.join(' ')).not.toMatch(/неизвестн|нет данных|null/i);
    expect(facts.length).toBe(1);
  });

  it('координаты идут парой, а не по одной', () => {
    expect(buildFacts({ ...bare, lat: 53.25 }).length).toBe(0);
    expect(buildFacts({ ...bare, lat: 53.25, lng: 158.75 }).join(' ')).toContain('53.25, 158.75');
  });

  it('пустой массив опасностей не превращается в факт', () => {
    expect(buildFacts({ ...bare, hazard_types: [] })).toEqual([]);
    expect(buildFacts({ ...bare, hazard_types: ['камнепад'] }).join(' ')).toContain('камнепад');
  });

  it('факты маршрута и факты точки собираются одним списком', () => {
    const facts = buildFacts({
      ...bare, kind: 'route', distance_km: 12.5, elevation_gain_m: 700,
      season: 'summer', park_name: 'Налычево',
    });
    expect(facts.length).toBe(5);
    expect(facts.join(' ')).toContain('12.5');
    expect(facts.join(' ')).toContain('Налычево');
  });
});

describe('запрос спрашивает факты, а не одно название', () => {
  it('в выборке есть профиль безопасности и паспорт маршрута', () => {
    expect(SRC).toContain('LEFT JOIN location_safety_profile');
    expect(SRC).toContain('LEFT JOIN kamchatka_routes');
    expect(SRC).toContain('lsp.hazard_types');
    expect(SRC).toContain('kr.distance_km');
  });

  it('координаты и тип объекта тоже', () => {
    expect(SRC).toContain('ark.lat');
    expect(SRC).toContain('ark.location_type');
  });
});

describe('квоты объёма не возвращаются', () => {
  it('в промпте нет требования минимального числа слов', () => {
    expect(SRC).not.toMatch(/не меньше \d+ слов/);
    expect(SRC).not.toContain('«Обобщённо» НЕ значит «кратко»');
  });

  it('опора на общие знания модели запрещена, а не разрешена', () => {
    expect(SRC).not.toContain('опирайся на название и тип и на свои общие знания');
    expect(SRC).toContain('общими знаниями о Камчатке пользоваться ЗАПРЕЩЕНО');
  });

  it('порог длины отсекает заглушку провайдера, а не краткость', () => {
    // Заглушка «Сервис временно недоступен.» — 27 символов.
    const m = SRC.match(/const MIN_GENERATION_LENGTH = (\d+);/);
    expect(m).not.toBeNull();
    const floor = Number(m![1]);
    expect(floor).toBeGreaterThan(27);
    expect(floor).toBeLessThan(60);
  });
});

describe('третий исход: писать не из чего', () => {
  it('запись без фактов и без описания не идёт в модель', () => {
    expect(SRC).toContain('noSource: true');
    expect(SRC).toContain('источника нет: в базе только название');
  });

  it('«нет источника» считается отдельно от ошибок', () => {
    expect(SRC).toContain('no_source: number');
    expect(SRC).toMatch(/if \(lacksSource\) \{[\s\S]*?noSource\+\+/);
  });
});

describe('происхождение записывается', () => {
  it('после UPDATE пишется строка в description_provenance', () => {
    expect(SRC).toContain('INSERT INTO description_provenance');
    expect(SRC).toContain('facts_count');
  });

  it('отказ журнала не глушится', () => {
    const block = SRC.slice(SRC.indexOf('INSERT INTO description_provenance'),
      SRC.indexOf('improved++', SRC.indexOf('INSERT INTO description_provenance')));
    expect(block).toContain('addErrorSample');
  });

  it('миграция объявлена', () => {
    const sql = readFileSync('migrations/911_description_provenance.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS description_provenance');
    expect(sql).toContain('facts_given');
  });
});
