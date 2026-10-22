/**
 * Описания-дневники снимаются с карточек до переписи по источникам (14.10,
 * слово владельца «2 да»; миграция 1247).
 *
 * Держится:
 *  - миграция переносит текст в архивную колонку, а не стирает его, и только
 *    поимённо названные переписью места, только пока текст тот же;
 *  - карточка говорит словами, что описание убрано и переписывается, — не
 *    молчит и не показывает дневник;
 *  - модели не заполняют освободившееся описание текстом по одному названию:
 *    оба писателя выводят такие места из очереди;
 *  - перепроверка заметок Кузьмича и перепись судят заметку по снятому
 *    тексту — тому, по которому её писали.
 * Экран судится рендером, SQL — по смыслу условий.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
// С 22.10 модель тексты мест не пишет — слово владельца
// (model-place-text-paused.test.ts держит выключенное). Здесь судится путь
// записи на день, когда его включат снова: проверки после модели должны
// стоять на месте.
vi.mock('@/lib/places/model-place-text', () => ({ MODEL_WRITES_PLACE_TEXT: true, MODEL_PLACE_TEXT_PAUSED_MESSAGE: '' }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin' })) }));
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(async () => ''),
  callAIQualityOrNull: vi.fn(async () => null),
  callAIWaterfall: vi.fn(async () => null),
  isWaterfallErrorResponse: () => false,
}));
vi.mock('@/lib/scraping/brightdata', () => ({ fetchViaBrightData: async () => null }));

import PlaceDescription from '@/components/places/PlaceDescription';
import { enrichDescriptions } from '@/app/api/admin/enrich-routes/route';
import { recheckExistingReviews } from '@/lib/agents/kuzmich-place-enricher';
import { descriptionVoice } from '@/lib/places/description-voice';
import { GET as descriptionCensus } from '@/app/api/cron/place-description-geo/route';
import { NextRequest } from 'next/server';

afterEach(cleanup);
// Тело в скобках: функция, возвращённая из beforeEach, vitest зовёт как уборку.
beforeEach(() => { queryMock.mockReset(); });

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1247_place_diary_descriptions_withdrawn.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const ROWS = [...BODY.matchAll(/\('([0-9a-f-]{36})', '((?:[^']|'')*)'\)/g)].map((m) => ({ id: m[1], head: m[2] }));

describe('миграция 1247', () => {
  it('111 мест поимённо; у каждого — начало дневника, как его назвала перепись', () => {
    expect(ROWS).toHaveLength(111);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(111);
    for (const r of ROWS) {
      expect(r.head.length, r.id).toBe(60);
      expect(r.head).not.toMatch(/�/);
    }
    // Начала — те самые дневники: правило переписи узнаёт голос и по ним.
    const diaryHeads = ROWS.filter((r) => descriptionVoice(r.head).voice === 'diary').length;
    expect(diaryHeads).toBeGreaterThan(30);
  });

  it('текст переезжает в архив, а не стирается; только пока он тот же', () => {
    expect(BODY).toMatch(/SET description_withdrawn = p\.description,/);
    expect(BODY).toMatch(/description = NULL,/);
    expect(BODY).toMatch(/AND p\.description_withdrawn IS NULL/);
    expect(BODY).toMatch(/AND left\(regexp_replace\(p\.description, '\^\\s\+', ''\), 60\) = d\.head/);
    expect(BODY).not.toMatch(/DELETE FROM places/);
  });
});

describe('карточка места', () => {
  it('снятое описание — словами, не тишиной', () => {
    render(<PlaceDescription name="Авачинский перевал" essence={null} description={null} descriptionWithdrawn placeId="p" />);
    expect(document.body.textContent).toMatch(/Описание этого места было написано не по источникам/);
    expect(document.body.textContent).toMatch(/Факты ниже — из\s+данных платформы/);
    // Обещания переписать нет (1310, «всю не правду»): переписывать сотни
    // снятых описаний некому, а работа, которой нет, — та же неправда.
    expect(document.body.textContent).not.toMatch(/переписываем/);
  });

  it('переписали — строки о снятии нет, есть текст', () => {
    render(<PlaceDescription name="Авачинский перевал" essence={null} description="Перевал между Авачинским и Корякским вулканами." descriptionWithdrawn placeId="p" />);
    expect(document.body.textContent).not.toMatch(/написано не по источникам/);
    expect(screen.getByText(/Перевал между Авачинским/)).toBeTruthy();
  });

  it('описания нет и не снимали — блока нет вовсе', () => {
    const { container } = render(<PlaceDescription name="X" essence={null} description={null} placeId="p" />);
    expect(container.textContent).toBe('');
  });

  it('раздел «О месте» открывается и ради строки о снятии', () => {
    const src = readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');
    expect(src).toMatch(/hasAbout = Boolean\(place\.essence \|\| place\.description \|\| place\.descriptionWithdrawn\)/);
    expect(src).toMatch(/descriptionWithdrawn=\{place\.descriptionWithdrawn\}/);
  });

  it('загрузчик карточки отдаёт признак снятия, а сам текст — нет', () => {
    const src = readFileSync(join(ROOT, 'lib/places/place-detail.ts'), 'utf-8');
    expect(src).toMatch(/\(p\.description_withdrawn IS NOT NULL\) AS description_withdrawn/);
    expect(src).not.toMatch(/p\.description_withdrawn,/);
  });
});

describe('модели не заполняют снятое описание текстом по названию', () => {
  it('писатель маршрутов и мест (enrich-routes) выводит такие места из очереди и из счёта', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    });
    await enrichDescriptions(20, false, false);
    const pick = String(queryMock.mock.calls.find((c) => /SELECT id, title/.test(String(c[0])))?.[0] ?? '');
    expect(pick).toMatch(/w\.ark_id = agent_route_knowledge\.id\s+AND w\.description_withdrawn IS NOT NULL/);
  });

  it('писатель мест (enrich-places) берёт в очередь только не снятые', () => {
    const src = readFileSync(join(ROOT, 'app/api/admin/enrich-places/route.ts'), 'utf-8');
    expect(src).toMatch(/AND description_withdrawn IS NULL AND \(\s*description IS NULL/);
  });
});

describe('заметки Кузьмича судятся по снятому тексту', () => {
  it('перепроверка читает описание или снятый дневник — и снимает заметку по дневнику', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("btrim(p.kuzmich_review) <> ''")) {
        expect(s).toMatch(/COALESCE\(p\.description, p\.description_withdrawn\) AS description/);
        return { rows: [{ id: 'a', name: 'Перевал', description: 'Вчера я поднялся на перевал.', kuzmich_review: 'Перевал у дороги.', hazard_types: null, profile_source: null, altitude_m: null }] };
      }
      if (s.includes('unnest(')) return { rows: [], rowCount: 1 };
      throw new Error(`неожиданный запрос: ${s}`);
    });
    const r = await recheckExistingReviews();
    expect(r.reasons.diary_description).toBe(1);
  });

  it('перепись заметок — тем же чтением', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/kuzmich-review-census/route.ts'), 'utf-8');
    expect(src).toMatch(/COALESCE\(p\.description, p\.description_withdrawn\) AS description/);
  });
});

describe('перепись описаний: снятые — очередь переписи, а не «описания нет»', () => {
  it('снятый дневник — свой счёт и список; пустое описание — как прежде', async () => {
    process.env.CRON_SECRET = 'test-secret';
    queryMock.mockResolvedValueOnce({ rows: [
      { id: '1', name: 'Авачинский перевал', lat: '53.24', lng: '158.80', description: null, withdrawn: true },
      { id: '2', name: 'Бухта', lat: '52.90', lng: '158.70', description: null, withdrawn: false },
      { id: '3', name: 'Сопка', lat: '53.00', lng: '158.60', description: 'Вчера я поднялся на сопку.', withdrawn: false },
    ] });
    const res = await descriptionCensus(new NextRequest('https://vedarai.ru/api/cron/place-description-geo', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const body = await res.json();
    expect(body.voice).toMatchObject({ withdrawn: 1, empty: 1, diary: 1 });
    expect(body.voice.withdrawn_items).toEqual([{ place: 'Авачинский перевал', place_id: '1' }]);
  });
});

