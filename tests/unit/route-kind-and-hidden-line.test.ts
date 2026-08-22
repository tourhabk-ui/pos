/**
 * Род записи и спрятанная линия — решения владельца 22.08.
 *
 * Пункт 1: у записи появляется род. Скрейп idilesom принёс «маршруты»,
 * которые на деле отвечают на вопрос «как добраться»: заброска плюс подход.
 * Род выводится СУДЬЁЙ по улике в данных, а не догадкой в SQL и не по имени
 * поставщика — иначе разметка станет тем же гаданием, от которого уходим.
 *
 * Пункт 2: линия, не сходящаяся с местом («не разобрать»), не рисуется.
 * Нарисованная, она обещает ведение так же уверенно, как проверенная.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineOwnership } from '@/lib/routes/line-ownership';

const migration = readFileSync(join(process.cwd(), 'migrations/903_route_kind.sql'), 'utf-8');
const actuator = readFileSync(
  join(process.cwd(), 'app/api/cron/route-kind-classify/route.ts'), 'utf-8');
const card = readFileSync(
  join(process.cwd(), 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');

describe('род записи маршрута', () => {
  it('колонка пускает только известные роды и «не знаю»', () => {
    expect(migration).toMatch(/route_kind IS NULL OR route_kind IN \('path', 'approach'\)/);
  });

  it('миграция род НЕ проставляет — это работа судьи, а не догадки в SQL', () => {
    expect(migration).not.toMatch(/UPDATE\s+kamchatka_routes\s+SET\s+route_kind\s*=\s*'/i);
  });

  it('основание разметки записывается рядом с родом', () => {
    expect(migration).toContain('route_kind_reason');
    expect(actuator).toMatch(/route_kind_reason = v\.reason/);
  });

  it('актуатор судит принадлежностью, а не источником и не размахом', () => {
    expect(actuator).toContain("from '@/lib/routes/line-ownership'");
    expect(actuator).toMatch(/own\.verdict === 'own_with_approach'/);
    expect(actuator).not.toMatch(/source ===|span_km|idilesom/);
  });

  it('по умолчанию сухой прогон: боевой только явным apply=1', () => {
    expect(actuator).toMatch(/apply = .*searchParams\.get\('apply'\) === '1'/);
    expect(actuator).toMatch(/if \(apply && decided\.length > 0\)/);
  });

  it('«не разобрать» и «чужая» рода НЕ получают — молчание не заполняется', () => {
    expect(actuator).toMatch(/} else \{\s*unset\+\+;/);
    expect(actuator).toContain('left_unset');
  });

  it('актуатор параметризован — массивы, не склейка строк', () => {
    expect(actuator).toMatch(/UNNEST\(\$1::uuid\[\]\)/);
    expect(actuator).not.toMatch(/\$\{.*\}`,?\s*$/m);
  });
});

describe('линия, не сошедшаяся с местом, не рисуется', () => {
  it('карточка прячет геометрию при вердикте «не разобрать»', () => {
    expect(card).toMatch(/const lineHidden = ownership\?\.verdict === 'unclear'/);
    expect(card).toMatch(/track && !lineHidden/);
  });

  it('вместо линии человек получает слова, а не пустую карту молча', () => {
    expect(card).toContain('мы не показываем её, пока не проверим на земле');
  });

  it('данные при этом не трогаются — прячется показ, не запись', () => {
    expect(card).not.toMatch(/geometry\s*=\s*null/i);
  });
});

describe('судья остаётся тем же на границах', () => {
  const point = { lat: 52.72, lng: 158.22 };
  const line = (lat: number, n: number): number[][] =>
    Array.from({ length: n }, (_, i) => [158.22 + i * 0.003, lat]);

  it('«своя» получает род пути, «своя с подъездом» — род заброски', () => {
    expect(lineOwnership({ routePoint: point, coords: line(52.72, 10) }).verdict).toBe('own');
    // Хвост за 8 км от записи — влитый подъезд.
    const long = Array.from({ length: 80 }, (_, i) => [158.22 + i * 0.015, 52.72]);
    expect(lineOwnership({ routePoint: point, coords: long }).verdict).toBe('own_with_approach');
  });

  it('линия между порогами прячется, а не размечается', () => {
    const mid = lineOwnership({ routePoint: point, coords: line(52.774, 10) });
    expect(mid.verdict).toBe('unclear');
  });
});
