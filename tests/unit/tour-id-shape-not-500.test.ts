/**
 * «Такого тура нет» — это 404, а не отказ сервера.
 *
 * ── Что нашлось обходом экранов туриста 26.09 ────────────────────────────
 *
 * После того как публичные чтения тура получили шлюз публикации, живой запрос
 * к черновику оператора дал не 404, а 500:
 *
 *   GET /api/tours/1  →  500
 *   {"error":"Ошибка загрузки тура","details":"invalid input syntax for type uuid: \\"1\\""}
 *
 * Дефект был не в шлюзе, а под ним. У роута две ветки, и каждая падала на id
 * ЧУЖОГО типа:
 *
 *   • `operator_tours.id` — bigint. На UUID первый запрос отвечал 22P02
 *     `invalid input syntax for type bigint`;
 *   • фолбэк на `agent_route_knowledge.id` — uuid. На числовом id он отвечал
 *     22P02 про uuid.
 *
 * Первый запрос выполнялся ВСЕГДА, поэтому до фолбэка дело не доходило
 * никогда: путь был объявлен, описан комментарием и не работал ни разу
 * (§10.09, объявленный исход без источника). Шлюз лишь сделал видимым то, что
 * и так было: любой id, которого нет на витрине, возвращал 500.
 *
 * Фолбэк убран, а не починен: тур — коммерческое предложение оператора,
 * маршрут — инструкция, место — географический факт (§4.1). Отдавать место под
 * видом тура значит обещать бронирование там, где его нет.
 *
 * Сторож держит ПРАВИЛО: id, которого не может существовать, отвечает 404 и не
 * доходит до базы; сама база о месте под видом тура больше не спрашивается.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockQuery = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const RAW = readFileSync(join(process.cwd(), 'app/api/tours/[id]/route.ts'), 'utf-8');
/** Код без комментариев: в них история как раз описана — и должна быть. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function req(): never {
  return new Request('http://localhost/api/tours/x') as never;
}

describe('форма id проверяется до базы', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('мусор в адресе — 404, и база не спрашивается', async () => {
    const { GET } = await import('@/app/api/tours/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: 'not-a-tour' }) });
    expect(res.status).toBe(404);
    expect(
      mockQuery,
      'запрос к базе с id, который не bigint и не uuid, отвечает 22P02 и превращает 404 в 500',
    ).not.toHaveBeenCalled();
  });

  it('UUID — тоже 404: тур ищется только среди туров', async () => {
    const { GET } = await import('@/app/api/tours/[id]/route');
    const res = await GET(req(), {
      params: Promise.resolve({ id: '44444444-4444-4444-4444-444444444444' }),
    });
    expect(res.status).toBe(404);
  });

  it('числовой id, которого нет на витрине, — 404, а не 500', async () => {
    const { GET } = await import('@/app/api/tours/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(404);
  });
});

describe('место и маршрут больше не выдаются за тур', () => {
  it('роут не спрашивает agent_route_knowledge', () => {
    expect(
      SRC.includes('agent_route_knowledge'),
      'вернулся фолбэк, отдающий место или маршрут под видом тура (§4.1)',
    ).toBe(false);
  });

  it('отказ не глушится: SQLSTATE уходит в лог', () => {
    expect(RAW).toMatch(/sqlstate/i);
  });
});
