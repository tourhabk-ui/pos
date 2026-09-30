/**
 * Публичное чтение тура спрашивает ШЛЮЗ ВИТРИНЫ — черновик оператора наружу
 * не выезжает.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * Условие «тур на витрине» стояло копией в каноническом чтении карточки
 * (`lib/tours/tour-detail-query.ts`) и НЕ стояло нигде больше. Проверено
 * исполнением на настоящем PostgreSQL: туры «Сплав по реке Быстрая»
 * (`is_active = true`, `is_published = false`) выезжали в ответ
 * `GET /api/tours` наравне с живым; `GET /api/tours/[id]` открывал их по
 * прямой ссылке; `GET /api/tours/[id]/slots` отдавал свободные даты по любому
 * id вовсе без взгляда на тур.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Не место, а ПРАВИЛО, и с двух сторон:
 *   1. сам шлюз (`publicTourSql`) содержит все три флага — иначе вызов его
 *      зеленел бы при выпотрошенном условии (§10.09: сторож, проверяющий
 *      только объявление, зеленеет ровно тогда, когда механизм отвалился);
 *   2. КАЖДЫЙ роут публичной поверхности туров (`app/api/tours/**`), читающий
 *      `operator_tours`, зовёт шлюз. Новый роут без гейта краснеет сам, а не
 *      после того, как черновик заметят на витрине;
 *   3. три сегодняшних роута — поведением: в SQL, который они реально
 *      отправляют, стоит `is_published`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { publicTourSql } from '@/lib/tours/public-visibility';
import { GET as toursList } from '@/app/api/tours/route';
import { GET as tourDetail } from '@/app/api/tours/[id]/route';
import { GET as tourSlots } from '@/app/api/tours/[id]/slots/route';

const TOURS_API = join(process.cwd(), 'app/api/tours');

/** Все файлы роутов публичной поверхности туров. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(p);
  }
  return out;
}

function req(url: string): Request {
  return new Request(url);
}
/** Next 15: params приходят Promise — синхронное чтение ломается в мажорной. */
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
});

describe('шлюз витрины туров — сам предикат', () => {
  it('держит все три флага, а не один', () => {
    const sql = publicTourSql('ot');
    expect(sql).toContain('ot.is_active = true');
    expect(sql).toContain('ot.is_published = true');
    expect(sql).toContain('ot.deleted_at IS NULL');
  });

  it('алиас подставляется, пустой — без префикса', () => {
    expect(publicTourSql('t')).toContain('t.is_published = true');
    expect(publicTourSql('')).toContain('is_published = true');
    expect(publicTourSql('')).not.toContain('.is_published');
  });

  it('алиас из чужих рук в SQL не подставляется', () => {
    expect(() => publicTourSql("t; DROP TABLE operator_tours --")).toThrow();
  });
});

describe('каждый публичный роут туров спрашивает шлюз', () => {
  const files = routeFiles(TOURS_API);

  it('роуты вообще найдены (перепись, смотрящая не туда, не выглядит успешной)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('роут, читающий operator_tours, зовёт publicTourSql', () => {
    const without: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      // Читатели тура — и через FROM, и через JOIN. JOIN здесь не для
      // красоты: именно им читает тур роут дат (`JOIN operator_tours ot`), и
      // первая редакция правила, спрашивавшая только FROM, пропустила его —
      // мутация это и показала. Чистые писатели (POST/PATCH оператора) под
      // правило не попадают: они пишут свой тур, а не показывают чужой витрине.
      if (!/(FROM|JOIN)\s+operator_tours/i.test(src)) continue;
      if (!src.includes('publicTourSql(')) without.push(f.replace(process.cwd() + '/', ''));
    }
    expect(
      without,
      'публичный роут туров читает operator_tours без шлюза витрины. '
      + 'Позовите publicTourSql (lib/tours/public-visibility.ts) — иначе наружу '
      + 'уедет черновик оператора (is_published = false)',
    ).toEqual([]);
  });
});

// Проверка MCP 29.09: публичный MCP и Кузьмич — тоже витрина. Резолвер тура
// смотрел только is_active и deleted_at: черновик находился картой и заявкой.
describe('туры на пути Кузьмича и MCP — через тот же шлюз', () => {
  const FILES = ['lib/kuzmich/tour-availability-tool.ts', 'lib/kuzmich/core.ts'];
  it('каждый FROM operator_tours в них зовёт publicTourSql', () => {
    for (const f of FILES) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      const reads = [...src.matchAll(/FROM operator_tours\b([\s\S]{0,400}?)(?:`|LIMIT|ORDER BY)/g)];
      expect(reads.length, f).toBeGreaterThan(0);
      for (const m of reads) expect(m[1], `${f}: ${m[0].slice(0, 100)}`).toMatch(/publicTourSql\(/);
    }
  });
});

describe('поведение трёх роутов: в отправленном SQL стоит is_published', () => {
  it('GET /api/tours — список', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await toursList(req('http://localhost/api/tours') as never);
    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).toContain('is_published = true');
    }
  });

  it('GET /api/tours/[id] — карточка', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await tourDetail(req('http://localhost/api/tours/1') as never, params('1'));
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('is_published = true');
  });

  it('GET /api/tours/[id]/slots — даты', async () => {
    poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await tourSlots(req('http://localhost/api/tours/1/slots') as never, params('1'));
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('is_published = true');
    // Тур не на витрине — «такого тура нет», а не «свободных дат нет»: пустой
    // список подменил бы одно состояние другим (§4.0).
    expect(res.status).toBe(404);
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });

  it('тур на витрине — даты считаются', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ date: '2026-07-01', available_slots: 8, booked_slots: 0, free_slots: 8 }], rowCount: 1 });
    const res = await tourSlots(req('http://localhost/api/tours/1/slots') as never, params('1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; slots: unknown[] };
    expect(body.success).toBe(true);
    expect(body.slots).toHaveLength(1);
  });
});
