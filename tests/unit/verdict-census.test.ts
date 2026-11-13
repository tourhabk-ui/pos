/**
 * Перепись вердиктов меряет то же, что видит человек.
 *
 * Владелец назвал риск до выката: «не пережестить, а то все маршруты станут
 * красными». Перепись — способ это проверить на всём справочнике, и её
 * единственная ценность в том, что она гоняет ТЕ ЖЕ правила и ТОТ ЖЕ сбор
 * сигналов, что и карточка маршрута. Быстрая пересборка «одним запросом»
 * была бы второй реализацией правил и мерила бы саму себя.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { runVerdictCensus } from '@/lib/routes/verdict-census';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const CENSUS = read('lib/routes/verdict-census.ts');
const API = read('app/api/cron/verdict-census/route.ts');

describe('перепись считает теми же правилами, что и экран', () => {
  it('зовёт настоящий сборщик сигналов, а не свой запрос', () => {
    expect(CENSUS).toMatch(/from '@\/lib\/routes\/collect-signals'/);
    expect(CENSUS).toMatch(/collectRouteSignals\(/);
  });

  it('зовёт настоящее ядро вердикта', () => {
    expect(CENSUS).toMatch(/from '@\/lib\/routes\/go-verdict'/);
    expect(CENSUS).toMatch(/goVerdict\(/);
  });

  it('своих порогов не заводит — иначе перепись мерила бы себя', () => {
    expect(CENSUS).not.toMatch(/severity\s*>=?\s*\d/);
    expect(CENSUS).not.toMatch(/'orange'|'red'/);
  });
});

describe('перепись различает незнание и пустоту', () => {
  it('null и пустой список считаются в РАЗНЫЕ счётчики', () => {
    expect(CENSUS).toContain('signal_null');
    expect(CENSUS).toContain('signal_empty');
    // Ветка `else if` — то, что не даёт одному съесть другой.
    expect(CENSUS).toMatch(/alerts === null[\s\S]{0,120}else if[\s\S]{0,80}length === 0/);
    expect(CENSUS).toMatch(/volcanoes === null[\s\S]{0,120}else if[\s\S]{0,80}length === 0/);
  });
});

describe('цифры не приукрашиваются', () => {
  it('ноль маршрутов не даёт ста процентов зелёных', () => {
    expect(CENSUS).toMatch(/routes_counted > 0[\s\S]{0,140}:\s*0/);
  });

  it('урезанный счёт назван, а не спрятан', () => {
    // Молчаливый потолок читается как «посчитали всё».
    expect(CENSUS).toContain('limited_to');
    expect(CENSUS).toContain('routes_total');
    expect(CENSUS).toContain('routes_counted');
  });

  it('перепись ничего не пишет', () => {
    expect(CENSUS).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });
});

describe('доступ к переписи', () => {
  it('закрыта секретом, как остальные кроны', () => {
    expect(API).toMatch(/getCronSecret\(request\)/);
    expect(API).toMatch(/timingSafeCompare/);
    expect(API).toMatch(/status:\s*401/);
  });

  it('проверка секрета идёт ДО запуска переписи', () => {
    expect(API.indexOf('timingSafeCompare')).toBeLessThan(API.indexOf('runVerdictCensus('));
  });

  it('отказ отдаётся ошибкой, а не пустой переписью', () => {
    // Пустой ответ читался бы как «маршрутов нет».
    expect(API).toMatch(/status:\s*500/);
    expect(API).not.toMatch(/catch[\s\S]{0,120}routes_total:\s*0/);
  });
});

/**
 * Маршруты с двумя разными id (12.11, #3302). Карточка живёт на id
 * представления — COALESCE(ark_id, id), — а сборщик сигналов до этого дня
 * искал строку только по её id: у таких маршрутов карточка показывала
 * «Осторожно — данных мало» при любом дне. Перепись называет, сколько их и
 * какой была их настоящая оценка, — вызовом на подменённой базе.
 */
describe('перепись называет маршруты, у которых id карточки не равен id строки', () => {
  const ROUTES = [
    { id: 'row-1', ark_id: null, title: 'Без ark_id' },
    { id: 'row-2', ark_id: 'card-2', title: 'С закрытой точкой' },
    { id: 'row-3', ark_id: 'row-3', title: 'ark_id равен id' },
    { id: 'row-4', ark_id: 'card-4', title: 'Спокойный' },
  ];

  beforeEach(() => {
    mockQuery.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      // Тревоги маршрута — первым правилом: их предикат сам содержит COUNT(*).
      if (/JOIN ark ON/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: String(ROUTES.length) }] };
      if (/SELECT id::text, ark_id::text AS ark_id, title FROM kamchatka_routes/.test(sql)) return { rows: ROUTES };
      if (/zone, season, lat/.test(sql)) return { rows: [{ id: params[0], zone: 'avachinsky', season: null, lat: '53.1', lng: '158.6' }] };
      if (/rs\.is_open = FALSE/.test(sql)) return { rows: params[0] === 'row-2' ? [{ name: 'Кордон', reason: null }] : [] };
      return { rows: [] };
    });
  });

  it('считает только те, где ark_id записан и отличается; настоящая оценка — по id строки', async () => {
    const c = await runVerdictCensus();
    expect(c.routes_counted).toBe(4);
    expect(c.card_id_differs.count).toBe(2);
    expect(c.card_id_differs.by_status).toEqual({ go: 1, caution: 0, no: 1 });
    const closed = c.card_id_differs.examples.find((e) => e.id === 'row-2');
    expect(closed).toEqual({ id: 'row-2', card_id: 'card-2', title: 'С закрытой точкой', status: 'no', reason: 'Закрыто: Кордон' });
    expect(c.card_id_differs.examples.map((e) => e.id).sort()).toEqual(['row-2', 'row-4']);
  });

  it('таких маршрутов нет — ноль, а не пропуск поля', async () => {
    const one = [ROUTES[0]!];
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/JOIN ark ON/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: '1' }] };
      if (/SELECT id::text, ark_id::text AS ark_id, title FROM kamchatka_routes/.test(sql)) return { rows: one };
      if (/zone, season, lat/.test(sql)) return { rows: [{ id: params[0], zone: null, season: null, lat: null, lng: null }] };
      return { rows: [] };
    });
    const c = await runVerdictCensus();
    expect(c.card_id_differs).toEqual({ count: 0, by_status: { go: 0, caution: 0, no: 0 }, examples: [] });
  });
});
