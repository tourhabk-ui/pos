/**
 * Сторож: поток туристов распределяется, лимит места — с источником.
 *
 * Владелец 25.09: «всех туристов нельзя в один поток направлять — 500
 * человек на одну локацию, где есть природоохранные ограничения».
 *
 * До этого дня планировщик лимитов не читал, спрос по местам не считал
 * никто, а единственная «вместимость» в схеме — capacity_per_day с DEFAULT
 * 50 у всех мест, то есть заглушка, а не норма.
 *
 * Держит связку целиком (§10.09):
 *   правило четырёх исходов — производитель спроса (брони) — производитель
 *   лимита (админ, с источником) — потребитель (recommendTrip) — слова
 *   человеку. И запрет на заглушку: capacity_per_day планировщик не читает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadVerdict, rankByLoad, firstOverLimit, overLimitText, dateOfTripDay, type PlaceLoad,
} from '@/lib/planner/flow-balance';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ENGINE = read('lib/planner/engine.ts');
const LOAD = read('lib/planner/place-load.ts');
const ADMIN = read('app/api/admin/places/[id]/visitor-limit/route.ts');
const MIGRATION = read('migrations/1016_places_visitor_limit.sql');

const place = (p: Partial<PlaceLoad>): PlaceLoad => ({
  placeId: 'p', name: 'Долина гейзеров', planned: 0, limit: null, limitSource: null, ...p,
});

describe('четыре исхода, а не два', () => {
  it('сверх лимита с вашей группой — over_limit, в пределах — within_limit', () => {
    const p = place({ planned: 48, limit: 50, limitSource: 'квота заповедника' });
    expect(loadVerdict(p, 2)).toBe('within_limit');
    expect(loadVerdict(p, 3)).toBe('over_limit');
  });

  it('лимита нет в данных — «не знаем», а не «свободно»', () => {
    expect(loadVerdict(place({ planned: 500, limit: null }), 1)).toBe('no_limit');
  });

  it('загрузку не посчитали — судить не о чем, даже при известном лимите', () => {
    expect(loadVerdict(place({ planned: null, limit: 50, limitSource: 'квота заповедника' }), 1)).toBe('not_counted');
  });
});

describe('выбор места', () => {
  const a = { id: 'a', title: 'A' };
  const b = { id: 'b', title: 'B' };
  const c = { id: 'c', title: 'C' };

  it('из равноценных первым идёт менее загруженный', () => {
    const loads = new Map([
      ['a', [place({ planned: 40 })]],
      ['b', [place({ planned: 5 })]],
      ['c', [place({ planned: 20 })]],
    ]);
    expect(rankByLoad([a, b, c], loads, 2).ranked.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('при равной загрузке порядок не трогается — нулевой спрос план не меняет', () => {
    const loads = new Map([['a', [place({})]], ['b', [place({})]], ['c', [place({})]]]);
    expect(rankByLoad([a, b, c], loads, 2).ranked).toEqual([a, b, c]);
  });

  it('упёршийся в лимит не предлагается и называется', () => {
    const full = place({ name: 'Долина гейзеров', planned: 50, limit: 50, limitSource: 'квота Кроноцкого заповедника' });
    const r = rankByLoad([a, b], new Map([['a', [full]], ['b', [place({})]]]), 1);
    expect(r.ranked).toEqual([b]);
    expect(r.blocked).toEqual([{ candidate: a, place: full }]);
    expect(overLimitText(full)).toContain('квота Кроноцкого заповедника');
  });

  it('маршрут упирается, если упирается хоть одно его место', () => {
    const places = [place({ planned: 1, limit: 100, limitSource: 'решение владельца' }), place({ name: 'Узон', planned: 30, limit: 30, limitSource: 'квота заповедника' })];
    expect(firstOverLimit(places, 1)?.name).toBe('Узон');
  });

  it('загрузку спросить не вышло — порядок нетронут, никто не отсеян', () => {
    expect(rankByLoad([a, b, c], null, 2)).toEqual({ ranked: [a, b, c], blocked: [] });
  });
});

describe('дата дня поездки', () => {
  it('день 1 — день прилёта', () => {
    expect(dateOfTripDay('2026-10-01', 1)).toBe('2026-10-01');
    expect(dateOfTripDay('2026-09-30', 3)).toBe('2026-10-02');
  });
  it('мусор — null, а не выдуманная дата', () => {
    expect(dateOfTripDay('не дата', 1)).toBeNull();
    expect(dateOfTripDay('2026-10-01', 0)).toBeNull();
  });
});

describe('производитель спроса — брони', () => {
  it('считает брони, кроме отменённых и неявок, и без связей «рядом»', () => {
    expect(LOAD).toContain("[...CANCELLED_BOOKING_STATUSES, 'no_show']");
    expect(LOAD).toMatch(/NOT \(b\.booking_status = ANY\(\$4::text\[\]\)\)/);
    expect((LOAD.match(/COALESCE\(rw\.link_kind, 'unknown'\) <> 'nearby'/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(LOAD).toContain('b.deleted_at IS NULL');
  });

  it('отказ запроса — null и строка в логе, а не ноль', () => {
    expect(LOAD).toMatch(/catch \(err\)[\s\S]*console\.error[\s\S]*return null;/);
  });
});

describe('производитель лимита — только с источником', () => {
  it('база не примет число без источника', () => {
    expect(MIGRATION).toMatch(/places_visitor_limit_has_source[\s\S]*visitor_limit_per_day IS NULL[\s\S]*length\(btrim\(visitor_limit_source\)\) >= 8/);
    expect(MIGRATION).not.toMatch(/visitor_limit_per_day INT[^;]*DEFAULT/);
  });

  it('писатель — админ, источник обязателен, старое значение в ответе', () => {
    expect(ADMIN).toContain('requireAdmin(request)');
    expect(ADMIN).toMatch(/source: z\.string\(\)\.trim\(\)\.min\(8/);
    expect(ADMIN).toContain('previous: { limit: r.old_limit, source: r.old_source }');
  });

  it('других писателей у лимита нет', () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        if (/visitor_limit_per_day\s*=/.test(read(p))) writers.push(p);
      }
    };
    walk('app'); walk('lib');
    expect(writers).toEqual(['app/api/admin/places/[id]/visitor-limit/route.ts']);
  });
});

describe('потребитель — планировщик', () => {
  it('самостоятельные дни ранжируются по загрузке, упёршиеся называются', () => {
    expect(ENGINE).toMatch(/rankByLoad\(dbRoutes, await fetchCandidateLoads\(/);
    expect(ENGINE).toContain('overLimit.add(');
    expect(ENGINE).toMatch(/type: 'crowd',[\s\S]{0,80}В ваши даты заполнено по норме/);
  });

  it('туру по месту сверх лимита — предупреждение на его дне, тур не убирается', () => {
    expect(ENGINE).toContain('fetchTourLoads(realTours.map(t => t.tourId)');
    expect(ENGINE).toContain('Природоохранный лимит в ваши даты');
  });

  it('заглушку capacity_per_day (DEFAULT 50 у всех) планировщик за лимит не принимает', () => {
    const planner = readdirSync(join(ROOT, 'lib/planner')).filter((f) => f.endsWith('.ts'));
    for (const f of planner) expect(read(`lib/planner/${f}`), f).not.toMatch(/capacity_per_day/);
  });
});
