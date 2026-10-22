/**
 * Модель не пишет тексты мест — слово владельца 22.10: «отключи агента
 * выдумывающкюего описание мест такую пургу придумал»
 * (lib/places/model-place-text.ts).
 *
 * Держится вызовом, а не текстом исходника:
 *  - выключатель выключен;
 *  - агент заметок «Кузьмич о месте» модель не зовёт и в базу заметок не
 *    пишет, а перепроверка стоящих работает дальше и снимает выдумку;
 *  - ручная партия описаний мест отвечает отказом раньше разбора тела, и
 *    `force` его не обходит;
 *  - писатель enrich-routes (с 15.10 — только места, по одному названию)
 *    не зовёт модель ни ночным кроном, ни ручным POST, и крон отвечает 200:
 *    решение человека не должно будить его каждую ночь.
 * Очередь Editor (прод и раннер) — на настоящем PostgreSQL:
 * tests/integration/editor-places-paused.pg.test.ts.
 *
 * Включить обратно — видимый коммит со словом владельца: этот файл тогда
 * правится вместе с выключателем.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const waterfallMock = vi.fn();
const fastMock = vi.fn();
const qualityMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIWaterfall: (...a: unknown[]) => waterfallMock(...a),
  callAIFast: (...a: unknown[]) => fastMock(...a),
  callAIQualityOrNull: (...a: unknown[]) => qualityMock(...a),
  isWaterfallErrorResponse: () => false,
}));
vi.mock('@/lib/scraping/brightdata', () => ({ fetchViaBrightData: async () => null }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => null) }));

import { MODEL_WRITES_PLACE_TEXT, MODEL_PLACE_TEXT_PAUSED_MESSAGE } from '@/lib/places/model-place-text';
import { runKuzmichPlaceEnricher } from '@/lib/agents/kuzmich-place-enricher';
import { POST as enrichPlaces } from '@/app/api/admin/enrich-places/route';
import { POST as enrichRoutesAdmin } from '@/app/api/admin/enrich-routes/route';
import { GET as enrichRoutesCron } from '@/app/api/cron/enrich-routes/route';

/** Стоящая заметка с выдумкой: медведи и часы пути, которых в данных места нет. */
const STOOD = {
  id: 'p-1', name: 'Массив Вачкажец',
  description: 'Горный массив на юге Камчатки. Высшая точка — 1556 м.',
  kuzmich_review: 'Часа четыре идти по осыпи, медведи тут повсюду.',
  hazard_types: [], profile_source: null, altitude_m: 1556,
};

beforeEach(() => {
  queryMock.mockReset();
  waterfallMock.mockReset();
  fastMock.mockReset();
  qualityMock.mockReset();
});

describe('выключатель', () => {
  it('выключен словом владельца 22.10', () => {
    expect(MODEL_WRITES_PLACE_TEXT).toBe(false);
    expect(MODEL_PLACE_TEXT_PAUSED_MESSAGE).toContain('22.10');
  });
});

describe('заметки «Кузьмич о месте»', () => {
  it('новых не пишет: модель не зовётся, кандидаты не выбираются, ответ называет выключенное', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) return { rows: [] };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const r = await runKuzmichPlaceEnricher(20);
    expect(waterfallMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('kuzmich_review IS NULL'))).toBe(false);
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('SET kuzmich_review = $1'))).toBe(false);
    expect(r).toMatchObject({ paused: true, processed: 0, enriched: 0, recheck_failed: false });
  });

  it('перепроверка стоящих работает дальше и снимает выдумку с карточки', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) return { rows: [STOOD] };
      if (s.includes('unnest(')) return { rows: [], rowCount: 1 };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(20);
    expect(r).toMatchObject({ paused: true, reset: 1, enriched: 0 });
    expect(waterfallMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('перепроверка не выполнилась — «не смог» виден и при выключенной записи', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) throw Object.assign(new Error('down'), { code: '08006' });
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runKuzmichPlaceEnricher(20);
    expect(r).toMatchObject({ paused: true, recheck_failed: true });
    err.mockRestore();
  });
});

describe('ручная партия описаний мест', () => {
  for (const body of [{ batch: 5 }, { batch: 5, force: true }]) {
    it(`отказ 409 без похода в базу и к модели: ${JSON.stringify(body)}`, async () => {
      const req = new NextRequest('http://localhost/api/admin/enrich-places', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const res = await enrichPlaces(req);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: MODEL_PLACE_TEXT_PAUSED_MESSAGE, paused: true });
      expect(queryMock).not.toHaveBeenCalled();
      expect(fastMock).not.toHaveBeenCalled();
    });
  }
});

describe('ночной писатель enrich-routes (с 15.10 — только места)', () => {
  const paused = { success: true, paused: true, processed: 0, improved: 0, errors: 0 };

  it('крон: 200 с paused, без базы и без модели', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const res = await enrichRoutesCron(new NextRequest('http://localhost/api/cron/enrich-routes', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ...paused, message: MODEL_PLACE_TEXT_PAUSED_MESSAGE });
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    }
    expect(queryMock).not.toHaveBeenCalled();
    expect(qualityMock).not.toHaveBeenCalled();
  });

  for (const body of [{ mode: 'description' }, { mode: 'description', force: true, dryRun: true }]) {
    it(`ручной POST ${JSON.stringify(body)}: то же — модель не зовётся`, async () => {
      const res = await enrichRoutesAdmin(new NextRequest('http://localhost/api/admin/enrich-routes', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject(paused);
      expect(queryMock).not.toHaveBeenCalled();
      expect(qualityMock).not.toHaveBeenCalled();
    });
  }
});
