/**
 * tests/unit/route-passports-import.test.ts
 *
 * Импорт официальных паспортов маршрутов (задача K), чистая логика без сети:
 * - извлечение PDF-ссылок из HTML страницы (заголовки секций → ведомство/сезон;
 *   не распознано → null, не выдумываем);
 * - нормализация названий и КОНСЕРВАТИВНЫЙ маппинг: matched только при
 *   единственном точном совпадении; частичное/множественное → ambiguous
 *   (никогда не привязывается); нет кандидатов → new;
 * - health-эндпоинт покрытия паспортами.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

import {
  extractPassportLinks,
  normalizeTitle,
  mapPassportToRoutes,
} from '@/lib/import/route-passports';
import { GET as getCoverage } from '@/app/api/admin/health/passport-coverage/route';

const PAGE_FIXTURE = `
<html><body>
<h2>Летние маршруты — КГБУ «Вулканы Камчатки»</h2>
<ul>
  <li><a href="/upload/passports/avacha-summer.pdf">Восхождение на Авачинский вулкан</a></li>
  <li><a href="https://visitkamchatka.ru/upload/passports/vachkazhec.pdf">Горный массив Вачкажец</a></li>
</ul>
<h3>Зимние маршруты Кроноцкого заповедника</h3>
<p><a href="/upload/passports/dolina-winter.pdf?v=2">Долина гейзеров (зимний)</a></p>
<a href="/upload/not-a-passport.html">Не PDF</a>
<a href="/upload/passports/dup.pdf"></a>
</body></html>`;

describe('extractPassportLinks', () => {
  it('собирает PDF-ссылки с абсолютными URL, ведомством и сезоном из секции', () => {
    const links = extractPassportLinks(PAGE_FIXTURE, 'https://visitkamchatka.ru/route-passports/');

    expect(links).toHaveLength(3);

    const avacha = links[0];
    expect(avacha.title).toBe('Восхождение на Авачинский вулкан');
    expect(avacha.pdfUrl).toBe('https://visitkamchatka.ru/upload/passports/avacha-summer.pdf');
    expect(avacha.agency).toBe('КГБУ «Вулканы Камчатки»');
    expect(avacha.season).toBe('summer');

    const dolina = links[2];
    expect(dolina.agency).toBe('ФГБУ «Кроноцкий заповедник»');
    expect(dolina.season).toBe('winter');
  });

  it('не-PDF и пустые ссылки не попадают в список', () => {
    const links = extractPassportLinks(PAGE_FIXTURE, 'https://visitkamchatka.ru/');
    expect(links.every(l => l.pdfUrl.includes('.pdf'))).toBe(true);
    expect(links.every(l => l.title.length > 0)).toBe(true);
  });

  it('нераспознанные ведомство/сезон — честный null', () => {
    const links = extractPassportLinks(
      `<a href="/x.pdf">Маршрут без контекста</a>`,
      'https://visitkamchatka.ru/'
    );
    expect(links[0].agency).toBeNull();
    expect(links[0].season).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('приводит регистр, ё, пунктуацию и стоп-слова', () => {
    expect(normalizeTitle('Восхождение на Авачинский вулкан')).toBe('авачинский вулкан');
    expect(normalizeTitle('«Вачкажец» — пеший маршрут')).toBe('вачкажец');
    expect(normalizeTitle('Озеро Зелёное')).toBe('озеро зеленое');
  });
});

describe('mapPassportToRoutes — консервативный маппинг', () => {
  const routes = [
    { id: 'r1', title: 'Авачинский вулкан' },
    { id: 'r2', title: 'Вачкажец' },
    { id: 'r3', title: 'Вачкажец (озеро Тахколоч)' },
    { id: 'r4', title: 'Мутновский вулкан' },
  ];

  it('единственное точное совпадение → matched', () => {
    const outcome = mapPassportToRoutes('Восхождение на Авачинский вулкан', routes);
    expect(outcome.kind).toBe('matched');
    if (outcome.kind === 'matched') expect(outcome.route.id).toBe('r1');
  });

  it('частичное совпадение с несколькими кандидатами → ambiguous, НЕ matched', () => {
    const outcome = mapPassportToRoutes('Горный массив Вачкажец', routes);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.candidates.map(c => c.id)).toContain('r2');
    }
  });

  it('нет кандидатов → new', () => {
    const outcome = mapPassportToRoutes('Ключевская сопка с севера', routes);
    expect(outcome.kind).toBe('new');
  });

  it('пустое после нормализации название → new, не крэш', () => {
    const outcome = mapPassportToRoutes('маршрут — тур', routes);
    expect(outcome.kind).toBe('new');
  });
});

describe('GET /api/admin/health/passport-coverage', () => {
  beforeEach(() => {
    queryMock.mockReset();
    requireAdminMock.mockReset();
    requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
  });

  it('считает покрытие и пустые категории', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY')) {
        return Promise.resolve({
          rows: [
            { category: 'vulkani', total: '50', with_passport: '20' },
            { category: 'rybalka', total: '30', with_passport: '0' },
          ],
        });
      }
      return Promise.resolve({ rows: [{ total: '294', with_passport: '100' }] });
    });

    const res = await getCoverage(new Request('http://localhost/api/admin/health/passport-coverage') as unknown as NextRequest);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      status: string; total_routes: number; routes_with_passport: number;
      coverage_pct: number; empty_categories: string[];
    };
    expect(body.status).toBe('ok');
    expect(body.total_routes).toBe(294);
    expect(body.routes_with_passport).toBe(100);
    expect(body.coverage_pct).toBeCloseTo(34, 0);
    expect(body.empty_categories).toEqual(['rybalka']);
  });

  it('ноль привязок → честный degraded с причиной', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ total: '294', with_passport: '0' }] });
    });

    const res = await getCoverage(new Request('http://localhost/api/admin/health/passport-coverage') as unknown as NextRequest);
    const body = await res.json() as { status: string; reason?: string };
    expect(body.status).toBe('degraded');
    expect(body.reason).toContain('не прогонялся');
  });

  it('не-админ не проходит', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    const res = await getCoverage(new Request('http://localhost/api/admin/health/passport-coverage') as unknown as NextRequest);
    expect(res.status).toBe(403);
  });
});
