/**
 * Сторож переписи #1493: у кого паспорт есть, а точек нет.
 *
 * Перепись исполняется на замоканном pool: ранжирование (координата в
 * тексте — первой), партия не больше десяти и только с координатой,
 * отказ запроса — null с причиной, а не пустой список. Признаки считаются
 * теми же инструментами, что у актуатора (parseDms), — это проверяется
 * настоящими строками, а не флагами.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { computeRouteEndpointsCensus, rankCandidates, CENSUS_BATCH, ENDPOINT_MENTION } from '@/lib/import/route-endpoints-census';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const row = (i: number, waypoints: number, markdown: string) => ({
  route_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  title: `Маршрут ${String(i).padStart(2, '0')}`,
  waypoints: String(waypoints),
  markdown,
  with_ocr: '0',
});

describe('перепись route-endpoints', () => {
  // Фигурные скобки не для красоты: mockReset() возвращает сам мок, а
  // функцию, возвращённую из хука, vitest зовёт как cleanup после теста —
  // и отвергающая реализация всплывала как необработанный reject (02.09).
  beforeEach(() => { poolQueryMock.mockReset(); });

  it('отказ запроса — null с причиной, не пустой список, лог написан', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    poolQueryMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const c = await computeRouteEndpointsCensus();
    expect(c.rows).toBeNull();
    expect(c.candidates).toBeNull();
    expect(c.next_batch).toEqual([]);
    expect(c.reason).toMatch(/не выполнился/);
    expect(errSpy.mock.calls[0]?.map(String).join(' ')).toContain('42P01');
    errSpy.mockRestore();
  });

  it('координата в тексте (тем же parseDms) идёт первой, партия ≤ 10 и только с координатой', async () => {
    const withCoord = Array.from({ length: 12 }, (_, i) =>
      row(100 + i, 0, `Пункт начала: кордон. Координаты начала 52°50'26"N 158°09'06"E`));
    const mentionsOnly = [row(1, 1, 'Начало маршрута — посёлок Эссо, конец маршрута — Анавгай')];
    const nothing = [row(2, 0, 'Описание природы без единой цифры.')];
    const done = [row(3, 2, 'уже две точки'), row(4, 3, 'три точки')];
    const all = [...nothing, ...mentionsOnly, ...withCoord, ...done].map(r => ({ ...r, with_ocr: '16' }));
    poolQueryMock.mockResolvedValue({ rows: all });

    const c = await computeRouteEndpointsCensus();
    expect(c.routes_with_ocr).toBe(16);
    expect(c.already_two_waypoints).toBe(2);
    expect(c.candidates).toBe(14);
    expect(c.with_coord_hint).toBe(12);
    expect(c.with_mentions_only).toBe(1);
    expect(c.without_signals).toBe(1);
    expect(c.next_batch).toHaveLength(CENSUS_BATCH);
    const byId = new Map((c.rows ?? []).map(r => [r.route_id, r]));
    for (const id of c.next_batch) expect(byId.get(id)?.coord_hint).toBe(true);
    // Порядок: координата → упоминание → без признаков.
    const kinds = (c.rows ?? []).map(r => (r.coord_hint ? 'c' : r.mentions_endpoints ? 'm' : 'n')).join('');
    expect(kinds).toBe('c'.repeat(12) + 'm' + 'n');
  });

  it('признак упоминания — те же слова, что в промпте актуатора', () => {
    expect(ENDPOINT_MENTION.test('Пункт окончания маршрута — база Родниковая')).toBe(true);
    expect(ENDPOINT_MENTION.test('Координаты конца: 53.1, 158.2')).toBe(true);
    expect(ENDPOINT_MENTION.test('Красивые виды на вулкан')).toBe(false);
  });

  it('rankCandidates устойчив: при равных признаках — по названию', () => {
    const a = { route_id: 'a', title: 'Б', waypoints: 0, markdown_chars: 1, coord_hint: false, mentions_endpoints: false };
    const b = { route_id: 'b', title: 'А', waypoints: 0, markdown_chars: 1, coord_hint: false, mentions_endpoints: false };
    expect(rankCandidates([a, b]).map(r => r.title)).toEqual(['А', 'Б']);
  });
});

describe('GET /api/cron/route-endpoints — перепись под секретом, только чтение', () => {
  const src = strip(readFileSync(join(ROOT, 'app/api/cron/route-endpoints/route.ts'), 'utf8'));

  it('GET экспортирован и проверяет секрет раньше переписи', () => {
    const at = src.indexOf('export async function GET');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 600);
    expect(body.indexOf('timingSafeCompare(')).toBeLessThan(body.indexOf('computeRouteEndpointsCensus('));
  });

  it('перепись не зовёт модель', () => {
    const census = strip(readFileSync(join(ROOT, 'lib/import/route-endpoints-census.ts'), 'utf8'));
    expect(census).not.toMatch(/callAI|providers/);
    expect(census).toMatch(/parseDms\(/);
    expect(census).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

describe('workflow партий', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/route-endpoints-batch.yml'), 'utf8');

  it('вручную или по маркеру, без расписания', () => {
    // 02.09: к workflow_dispatch добавлен push по маркеру
    // .github/triggers/route-endpoints-batch.json — dispatch через интеграцию
    // даёт 403. 03.09 маркер несёт все входы, а не только перепись: сухой
    // прогон ничего не пишет, а ждал клика владельца сутки.
    // Расписания по-прежнему нет: партия — решение человека, не крона.
    expect(wf).toMatch(/^\s+workflow_dispatch:/m);
    expect(wf).toMatch(/^\s+paths:\n\s+- '\.github\/triggers\/route-endpoints-batch\.json'/m);
    expect(wf).not.toMatch(/^\s+schedule:/m);
    // Права — только чтение репозитория (маркер), ничего не пишется.
    expect(wf).toMatch(/^permissions:\n\s+contents: read$/m);
  });

  it('умолчание маркера без mode — перепись, а не партия', () => {
    // Файл, забытый в репозитории, не должен однажды уехать боевой партией.
    expect(wf).toMatch(/pick\('IN_MODE', 'mode', 'census'\)/);
  });

  it('маркер даёт все входы, а не только режим', () => {
    for (const key of ['route_ids', 'source', 'why']) {
      expect(wf).toContain(`'${key}'`);
    }
  });

  it('боевая партия требует source и why и не больше 10 id', () => {
    expect(wf).toMatch(/"\$MODE" = "apply"[^\n]*\[ -z "\$SOURCE" \][^\n]*\[ -z "\$WHY" \]/);
    expect(wf).toMatch(/-gt 10/);
  });

  it('не-200 — исход не установлен, красный', () => {
    expect(wf).toMatch(/исход не установлен, зелёным не считать/);
  });
});
