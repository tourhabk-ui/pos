/**
 * Уборка «маршрутов», которые на самом деле места.
 *
 * Сторож держит границу критерия: узкий он потому, что широкий («без
 * точек») снёс бы настоящие маршруты — «Налычевское кольцо» и «Забег на
 * Аагские источники» тоже стоят без waypoints.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTwinJunk, blockers, hasRealTrack, type TwinFacts } from '@/lib/routes/twins';

const ROOT = process.cwd();

const base: TwinFacts = {
  title: 'Озеро Синичкино', hasPlaceTwin: true, waypointCount: 0,
  hasDistance: false, tourCount: 0, geometrySource: null, hasGeometry: false,
};

describe('критерий двойника', () => {
  it('имя места + ноль точек + нет дистанции — мусор', () => {
    expect(isTwinJunk(base)).toBe(true);
  });

  it('настоящий маршрут без точек НЕ трогаем — у него нет места-тёзки', () => {
    expect(isTwinJunk({ ...base, title: 'Налычевское кольцо', hasPlaceTwin: false })).toBe(false);
  });

  it('маршрут, названный по цели, но с точками — настоящий путь', () => {
    // «Долина гейзеров» с четырьмя waypoints — маршрут, а не карточка места
    expect(isTwinJunk({ ...base, title: 'Долина гейзеров', waypointCount: 4 })).toBe(false);
  });

  it('двойник с дистанцией — не трогаем: дистанция говорит о пути', () => {
    expect(isTwinJunk({ ...base, hasDistance: true })).toBe(false);
  });
});

describe('стоп-условия', () => {
  it('тур на записи держит её на витрине', () => {
    const stop = blockers({ ...base, tourCount: 1 });
    expect(stop.some(s => s.includes('тур'))).toBe(true);
  });

  it('настоящий трек держит запись до решения о его судьбе', () => {
    const stop = blockers({ ...base, hasGeometry: true, geometrySource: 'idilesom' });
    expect(stop.some(s => s.includes('трек'))).toBe(true);
  });

  it('синтетическая линия — не трек, она не держит', () => {
    expect(hasRealTrack({ ...base, hasGeometry: true, geometrySource: 'waypoints_synthetic' })).toBe(false);
    expect(blockers({ ...base, hasGeometry: true, geometrySource: 'waypoints_synthetic' })).toHaveLength(0);
  });

  it('проложенная нами линия по графу — тоже не повод держать', () => {
    expect(hasRealTrack({ ...base, hasGeometry: true, geometrySource: 'road_graph_astar' })).toBe(false);
  });
});

describe('обещания эндпоинта', () => {
  const src = readFileSync(join(ROOT, 'app/api/cron/route-twins-hide/route.ts'), 'utf-8');

  it('убирание — скрытие, а не DELETE (на маршруты смотрят FK)', () => {
    expect(src).toContain('is_visible = false');
    expect(src, 'DELETE уронил бы тур по FK').not.toMatch(/DELETE\s+FROM\s+kamchatka_routes/i);
  });

  it('есть откат тем же эндпоинтом', () => {
    expect(src).toContain("'restore'");
    expect(src).toContain('is_visible = true');
  });

  it('трогает только живые записи', () => {
    expect(src).toContain('r.is_visible = true');
    expect(src).toContain('r.merged_into_id IS NULL');
  });
});
