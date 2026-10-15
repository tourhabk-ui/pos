/**
 * Описание, написанное моделью, подписано на карточке места (15.10, §0
 * «честность»).
 *
 * Машинный текст читался наравне с текстом из справочника. Журнал
 * происхождения (description_provenance, 911) пишут Editor и enrich-places;
 * enrich-routes, пишущий описания мест по названию, журнала не вёл — его
 * тексты было не отличить ничем.
 *
 * Правило — вызовом; подпись — рендером; запись журнала enrich-routes —
 * вызовом писателя с подставной базой. Чтение журнала карточкой проверено на
 * PostgreSQL: модель и та же длина — подпись есть; после модели решение
 * владельца — нет; текст правлен после модели — нет.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin' })) }));
const TEXT = 'Озеро Тестовое лежит в лесу. ' + 'Берега пологие, к воде ведёт тропа от дороги. '.repeat(3);
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(async () => ''),
  callAIQualityOrNull: vi.fn(async () => TEXT),
  callAIWaterfall: vi.fn(async () => null),
  isWaterfallErrorResponse: () => false,
}));
vi.mock('@/lib/scraping/brightdata', () => ({ fetchViaBrightData: async () => null }));

import PlaceDescription from '@/components/places/PlaceDescription';
import { descriptionWrittenByModel, isModelDescriptionWriter } from '@/lib/places/description-by-model';
import { enrichDescriptions } from '@/app/api/admin/enrich-routes/route';

afterEach(() => { cleanup(); queryMock.mockReset(); });

describe('правило «написала модель»', () => {
  it('писатели-модели узнаются по имени в журнале; решение владельца — нет', () => {
    for (const w of ['editor-ai', 'editor-ai-runner:some-model', 'enrich-places-ai', 'enrich-routes-ai']) {
      expect(isModelDescriptionWriter(w), w).toBe(true);
    }
    expect(isModelDescriptionWriter('owner-decision')).toBe(false);
    expect(isModelDescriptionWriter(null)).toBe(false);
  });

  it('подпись — только когда длина текста та же, что записала модель', () => {
    expect(descriptionWrittenByModel({ by: 'editor-ai', chars: 120 }, 120)).toBe(true);
    expect(descriptionWrittenByModel({ by: 'editor-ai', chars: 120 }, 131)).toBe(false);
    expect(descriptionWrittenByModel({ by: 'owner-decision', chars: 120 }, 120)).toBe(false);
    expect(descriptionWrittenByModel(null, 120)).toBe(false);
  });
});

describe('карточка', () => {
  it('описание модели подписано, обычное — нет', () => {
    const { container, rerender } = render(<PlaceDescription name="X" essence={null} description="Текст о месте." byModel placeId="p" />);
    expect(container.textContent).toContain('Описание написала модель по данным платформы');
    rerender(<PlaceDescription name="X" essence={null} description="Текст о месте." placeId="p" />);
    expect(container.textContent).not.toContain('написала модель');
  });
});

describe('enrich-routes ведёт журнал происхождения', () => {
  it('записанное описание места оставляет строку журнала с именем писателя и длиной текста', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title, description/.test(sql)) {
        return { rows: [{ id: '88888888-8888-8888-8888-888888888888', title: 'Озеро Тестовое', description: null, category: 'lakes', location_type: 'lake', activity_type: null, lat: 53, lng: 158, payload: {} }] };
      }
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    });
    await enrichDescriptions(1, false, false);
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO description_provenance/.test(String(c[0])));
    expect(insert, 'журнал не записан').toBeDefined();
    expect(String(insert![0])).toContain("'enrich-routes-ai'");
    expect(insert![1]).toEqual(expect.arrayContaining(['88888888-8888-8888-8888-888888888888', TEXT.trim().length]));
  });
});

describe('перепись писателей описаний судит той же функцией, что карточка', () => {
  it('модель с той же длиной, модель и правка после, владелец, без журнала', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { last_write: { by: 'editor-ai', chars: 10 }, chars: 10 },
        { last_write: { by: 'enrich-routes-ai', chars: 10 }, chars: 12 },
        { last_write: { by: 'owner-decision', chars: 10 }, chars: 10 },
        { last_write: null, chars: 30 },
      ],
    });
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/description-writers-census/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost/x', { headers: { authorization: 'Bearer test-secret' } }));
    process.env.CRON_SECRET = prev;
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, visible_with_description: 4, by_model: 1, model_then_edited: 1, owner_or_other_writer: 1, no_journal: 1 });
  });
});
