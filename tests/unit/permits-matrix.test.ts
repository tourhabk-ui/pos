/**
 * tests/unit/permits-matrix.test.ts
 *
 * Матрица разрешений (issue #367, миграция 723):
 * - matchTitleToPark: уверенные привязки по вершинам, исключения
 *   (Авачинская бухта — не Налычево), «Камень» только ambiguous,
 *   границы слов в кириллице;
 * - /api/parks/[slug] отдаёт permitChannels, NULL-каналы не ломают ответ.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { matchTitleToPark } from '@/lib/parks/permit-matrix';
import { GET as getPark } from '@/app/api/parks/[slug]/route';

beforeEach(() => {
  poolQueryMock.mockReset();
});

describe('matchTitleToPark', () => {
  it('вершины Налычево привязываются уверенно', () => {
    expect(matchTitleToPark('Восхождение на Авачинский вулкан')).toMatchObject({
      parkSlug: 'nalychevo', vertex: 'Авачинский', confidence: 'matched',
    });
    expect(matchTitleToPark('Корякский вулкан за один день')).toMatchObject({
      parkSlug: 'nalychevo', confidence: 'matched',
    });
    expect(matchTitleToPark('Гора Ааг и перевал')).toMatchObject({
      parkSlug: 'nalychevo', vertex: 'Ааг',
    });
  });

  it('Авачинская бухта — НЕ Налычево (исключение)', () => {
    expect(matchTitleToPark('Прогулка по Авачинской бухте на сапах')).toBeNull();
    expect(matchTitleToPark('Морская прогулка: Авачинский залив')).toBeNull();
  });

  it('границы слов: вхождение внутри другого слова не матчится', () => {
    expect(matchTitleToPark('Тур по Саагским холмам')).toBeNull();
  });

  it('Ключевской: Ключевская и Толбачик', () => {
    expect(matchTitleToPark('Ключевская Сопка с севера')).toMatchObject({
      parkSlug: 'klyuchevskoy', confidence: 'matched',
    });
    expect(matchTitleToPark('Мёртвый лес и Толбачик')).toMatchObject({
      parkSlug: 'klyuchevskoy', vertex: 'Толбачик',
    });
  });

  it('«Камень» — только ambiguous, автопривязки нет', () => {
    expect(matchTitleToPark('Вулкан Камень: траверс')).toMatchObject({
      parkSlug: 'klyuchevskoy', vertex: 'Камень', confidence: 'ambiguous',
    });
    // Нарицательное «камень» в нижнем регистре не ловится вовсе
    expect(matchTitleToPark('Тропа через камень и стланик')).toBeNull();
  });

  it('Вачкажец — памятник природы', () => {
    expect(matchTitleToPark('Вачкажец и озеро Тахколоч')).toMatchObject({
      parkSlug: 'vachkazhets', confidence: 'matched',
    });
  });

  it('нет вершин — нет привязки', () => {
    expect(matchTitleToPark('Халактырский пляж на закате')).toBeNull();
  });
});

describe('GET /api/parks/[slug] — каналы разрешений', () => {
  const PARK_ROW = {
    slug: 'nalychevo',
    display_name: 'Природный парк «Налычево»',
    description: 'Описание',
    zone: 'avachinsky',
    mchs_phone: '+7 (4152) 23-53-62',
    permit_url: 'https://nalychevo.ru',
    permit_email: null,
    permit_office_address: null,
    permit_office_hours: null,
    permit_gosuslugi_url: null,
    permit_online_url: null,
    search_term: 'Налычево',
  };

  it('NULL-каналы не ломают ответ, permitChannels присутствует', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM parks')) return Promise.resolve({ rows: [PARK_ROW] });
      if (sql.includes('FROM kamchatka_routes')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPark(new Request('http://localhost/api/parks/nalychevo'), {
      params: Promise.resolve({ slug: 'nalychevo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permitChannels).toEqual({
      email: null, officeAddress: null, officeHours: null,
      gosuslugiUrl: null, onlineUrl: null,
    });
  });

  it('заполненные каналы отдаются camelCase', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM parks')) {
        return Promise.resolve({
          rows: [{
            ...PARK_ROW,
            permit_email: 'permit@nalychevo.ru',
            permit_gosuslugi_url: 'https://gosuslugi41.ru/x',
          }],
        });
      }
      if (sql.includes('FROM kamchatka_routes')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPark(new Request('http://localhost/api/parks/nalychevo'), {
      params: Promise.resolve({ slug: 'nalychevo' }),
    });
    const body = await res.json();
    expect(body.permitChannels.email).toBe('permit@nalychevo.ru');
    expect(body.permitChannels.gosuslugiUrl).toBe('https://gosuslugi41.ru/x');
  });
});
