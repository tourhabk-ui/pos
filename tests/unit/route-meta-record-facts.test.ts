/**
 * Короткий сниппет маршрута добирается полями записи — территорией и высшей
 * точкой трека (замечание Сыщика 21.11). Поля нет — ничего не добавляется.
 */
import { describe, it, expect } from 'vitest';
import { routeDescription, type RouteMetaFacts } from '@/lib/seo/place-meta';

const base: RouteMetaFacts = {
  title: 'Водопад Ольга', zone: null, distanceKm: 0.6, durationHours: null, durationDays: null,
  elevationGainM: 41, difficulty: 'easy', season: null, mchsRequired: false, description: null,
};

describe('routeDescription: добор короткого сниппета полями записи', () => {
  it('полей нет — сниппет как был', () => {
    expect(routeDescription(base)).toBe('Водопад Ольга — маршрут на Камчатке: 0,6 км · набор 41 м · сложность лёгкая.');
  });

  it('территория и высшая точка — когда записаны', () => {
    const d = routeDescription({ ...base, parkName: 'Природный парк «Налычево»', elevationMaxM: 412.4 });
    expect(d).toBe('Водопад Ольга — маршрут на Камчатке: 0,6 км · набор 41 м · сложность лёгкая. Территория: Природный парк «Налычево». Высшая точка: 412 м.');
    expect(d.length).toBeLessThanOrEqual(160);
  });

  it('территория уже в названии — не повторяется', () => {
    const d = routeDescription({ ...base, title: 'Налычево', parkName: 'Налычево', elevationMaxM: null });
    expect(d).not.toContain('Территория');
  });

  it('у сниппета с описанием добавок нет', () => {
    const d = routeDescription({
      ...base, parkName: 'Природный парк «Налычево»', elevationMaxM: 412,
      description: 'Короткая тропа к водопаду в распадке, по пути — смотровая площадка и ручей с мостиком.',
    });
    expect(d).not.toContain('Территория');
    expect(d).not.toContain('Высшая точка');
  });

  it('не влезает целиком — добавки нет, обрубка тоже', () => {
    const d = routeDescription({ ...base, parkName: 'Я'.repeat(90), elevationMaxM: 1200 });
    expect(d).not.toContain('Я'.repeat(5));
    expect(d).toContain('Высшая точка: 1200 м.');
  });
});
