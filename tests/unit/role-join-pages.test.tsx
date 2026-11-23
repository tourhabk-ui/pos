// @vitest-environment jsdom
/**
 * Страницы-входы для ролей партнёров (план готовности 23.11, этап 3a).
 *
 * Понятный вход был только у туроператора; `/guides/join`, `/stays/join` и
 * `/transfers/join` отвечали 404. Теперь у гида, хозяина жилья и перевозчика
 * своя страница, и она ведёт на ОБЩУЮ форму регистрации с выбранной ролью —
 * второй двери регистрации нет. Тексты — только то, что платформа делает:
 * ни выплат, ни сроков, ни тарифов. Судится рендером самих страниц.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const { getPlatformCounts } = vi.hoisted(() => ({ getPlatformCounts: vi.fn() }));
vi.mock('@/lib/stats/platform-counts', () => ({ getPlatformCounts }));

import GuidesJoin, { metadata as guidesMeta } from '@/app/guides/join/page';
import StaysJoin, { metadata as staysMeta } from '@/app/stays/join/page';
import TransfersJoin, { metadata as transfersMeta } from '@/app/transfers/join/page';
import { JOIN_COMMON, JOIN_PAGES, ROLE_ENTRY_LINKS } from '@/lib/partners/join-pages';
import { ROLE_HUB } from '@/lib/auth/role-routes';

afterEach(() => cleanup());

const PAGES = [
  { role: 'guide', path: '/guides/join', Page: GuidesJoin, meta: guidesMeta },
  { role: 'stay', path: '/stays/join', Page: StaysJoin, meta: staysMeta },
  { role: 'transfer', path: '/transfers/join', Page: TransfersJoin, meta: transfersMeta },
] as const;

/** Обещания, которых у платформы нет: деньги, сроки, тарифы, числа успеха. */
const PROMISES = [/выплат/i, /комисси/i, /тариф/i, /бесплатн/i, /месяц/i, /гарант/i, /\d+\s*%/, /удержива/i];

describe.each(PAGES)('страница роли $path', ({ role, path, Page, meta }) => {
  const html = () => render(<Page />).container;

  it('один заголовок страницы и кнопка регистрации с этой ролью', () => {
    const c = html();
    expect(c.querySelectorAll('h1')).toHaveLength(1);
    const cta = [...c.querySelectorAll('a')].find((a) => a.textContent?.includes('Зарегистрироваться'));
    expect(cta?.getAttribute('href')).toBe(`/auth/login?mode=register&role=${role}`);
  });

  it('своей формы на странице нет: регистрирует общая дверь', () => {
    const c = html();
    expect(c.querySelector('form')).toBeNull();
    expect(c.querySelector('input')).toBeNull();
  });

  it('статус платформы назван, обещаний нет', () => {
    const text = html().textContent ?? '';
    expect(text).toContain(JOIN_COMMON.status);
    expect(text).toContain('Заявка — не бронь');
    expect(text).toContain('турист платит вам напрямую');
    for (const promise of PROMISES) expect(text, String(promise)).not.toMatch(promise);
  });

  it('четыре шага подключения, и канал уведомлений — те же слова, что в справке', () => {
    const c = html();
    expect(c.querySelectorAll('ol > li')).toHaveLength(JOIN_COMMON.steps.length);
    const text = c.textContent ?? '';
    expect(text).toContain('«Подключить MAX»');
    expect(text).toContain('«Подключить Telegram»');
    expect(text).toContain('администратор');
  });

  it('оферта и входы других ролей — ссылками; на себя страница не ссылается', () => {
    const hrefs = [...html().querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/legal/offer');
    for (const other of ROLE_ENTRY_LINKS.filter((l) => l.href !== path)) expect(hrefs, other.href).toContain(other.href);
    expect(hrefs).not.toContain(path);
  });

  it('адрес канонический, заголовок и описание заданы, кабинет роли существует', () => {
    expect(meta.alternates?.canonical).toBe(path);
    expect(String(meta.title).length).toBeGreaterThan(20);
    const description = String(meta.description);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    for (const promise of PROMISES) expect(description, String(promise)).not.toMatch(promise);
    // Роль ведёт в кабинет, который есть на диске.
    expect(ROLE_HUB[role]).toMatch(/^\/hub\//);
    expect(existsSync(join(process.cwd(), 'app', ROLE_HUB[role], 'layout.tsx'))).toBe(true);
    // Статическая страница перекрывает динамический сегмент рядом.
    expect(existsSync(join(process.cwd(), 'app', path, 'page.tsx'))).toBe(true);
  });
});

describe('тексты страниц ролей', () => {
  it('у каждой роли — свои «что делает Ведар» и «что важно знать»', () => {
    for (const page of Object.values(JOIN_PAGES)) {
      expect(page.does.length, page.role).toBeGreaterThanOrEqual(3);
      expect(page.notes.length, page.role).toBeGreaterThanOrEqual(1);
      for (const line of [...page.does, ...page.notes, page.lead, page.title]) {
        for (const promise of PROMISES) expect(line, `${page.role}: ${promise}`).not.toMatch(promise);
      }
    }
  });

  it('входы ролей: туроператор и три страницы, агента нет', () => {
    expect(ROLE_ENTRY_LINKS.map((l) => l.href)).toEqual(['/operators/join', '/guides/join', '/stays/join', '/transfers/join']);
    expect(JSON.stringify(ROLE_ENTRY_LINKS)).not.toMatch(/agent|агент/i);
  });
});

describe('со страниц туроператора — ссылки на входы других ролей', () => {
  it('/for-operators', async () => {
    getPlatformCounts.mockResolvedValue({ routes: 366, places: 0, mchsRoutes: 0, safetyProfiles: 0, placesByType: {}, storefrontTours: 81 });
    const { default: ForOperators } = await import('@/app/for-operators/page');
    const c = render(await ForOperators()).container;
    expect(c.textContent).toContain('Не туроператор?');
    const hrefs = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const p of ['/guides/join', '/stays/join', '/transfers/join']) expect(hrefs, p).toContain(p);
    expect(c.querySelectorAll('h1')).toHaveLength(1);
  });

  it('/operators/join', async () => {
    const { default: JoinClient } = await import('@/app/operators/join/_JoinClient');
    const c = render(<JoinClient routesLine={null} />).container;
    expect(c.textContent).toContain('Не туроператор?');
    const hrefs = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const p of ['/guides/join', '/stays/join', '/transfers/join']) expect(hrefs, p).toContain(p);
  });
});
