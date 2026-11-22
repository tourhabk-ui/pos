// @vitest-environment jsdom
/**
 * Справка «Нужно ли разрешение на посещение» (#3566 п.5, 21.11) — рендером.
 *
 * Держит: факты страницы — из справочника lib/safety/park-permit (способы
 * парка, порядок Кроноцкого, переход парков под Минприроды, место без
 * разрешения), каждый блок со ссылкой на источник; разрешение названо не
 * регистрацией в МЧС; FAQPage совпадает с видимыми вопросами; блок
 * разрешения на карточке ведёт на справку; адрес — в sitemap.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { PermitGuideView } from '@/components/seo/PermitGuide';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import {
  FEDERAL_PERMIT_UNKNOWN_RU, GREEN_BUTTON, KRONOKI_ORDER_RU, KRONOKI_REQUESTS, KRONOKI_TERRITORIES, NO_PERMIT_TERRITORIES,
  PARK_PERMIT_CHANNELS, PARK_PERMIT_SOURCE, VOLCANOES_DECREE_DOC,
} from '@/lib/safety/park-permit';
import { PERMIT_NOT_MCHS_RU, routePermitCase, type ParkLookup } from '@/lib/parks/route-permit';
import { permitCardCase } from '@/lib/parks/route-permit-card';
import { PERMIT_GUIDE_PATH, ROUTE_PASSPORTS_REGISTRY, permitFaq } from '@/lib/seo/permit-guide';

const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

function shot(ui: React.ReactElement) {
  const { container } = render(ui);
  return {
    t: text(container),
    links: [...container.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    ld: [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? '{}')),
  };
}

describe('страница о разрешениях — факты из справочника, с источниками', () => {
  const { t, links, ld } = shot(<PermitGuideView />);

  it('разрешение — не регистрация в МЧС; ссылка на форму регистрации выхода', () => {
    expect(t).toContain(PERMIT_NOT_MCHS_RU);
    expect(links).toContain('/register');
  });

  it('все способы краевого парка и источник с датой', () => {
    for (const c of PARK_PERMIT_CHANNELS) expect(t).toContain(c.detail);
    expect(links).toContain(GREEN_BUTTON.androidUrl);
    if (GREEN_BUTTON.iosUrl) expect(links).toContain(GREEN_BUTTON.iosUrl);
    expect(links).toContain(PARK_PERMIT_SOURCE.url);
    expect(t).toContain(PARK_PERMIT_SOURCE.asOf);
  });

  it('парки под Минприроды — со ссылкой на постановление и «как теперь — не объявлено»', () => {
    expect(t).toContain(FEDERAL_PERMIT_UNKNOWN_RU);
    expect(links).toContain(VOLCANOES_DECREE_DOC.url);
  });

  it('Кроноцкий: свой порядок, все три территории, страница заявок', () => {
    expect(t).toContain(KRONOKI_ORDER_RU);
    for (const terr of KRONOKI_TERRITORIES) expect(t).toContain(terr.name);
    expect(links).toContain(KRONOKI_REQUESTS.url);
  });

  it('место без разрешения — с основанием и источником; реестр паспортов — ссылкой', () => {
    for (const n of NO_PERMIT_TERRITORIES) {
      expect(t).toContain(n.name);
      expect(links).toContain(n.url);
    }
    expect(links).toContain(ROUTE_PASSPORTS_REGISTRY.url);
  });

  it('Article, хлебные крошки и строка редакции; FAQPage — те же вопросы, что видит человек', () => {
    const graph = ld.flatMap((x) => (Array.isArray(x['@graph']) ? x['@graph'] : [x]));
    const article = graph.find((x) => x['@type'] === 'Article');
    expect(article?.author).toMatchObject({ '@type': 'Organization', name: 'Редакция Vedar' });
    expect(article?.dateModified).toMatch(/^2026-11-21/);
    const crumbs = graph.find((x) => x['@type'] === 'BreadcrumbList');
    expect(crumbs).toBeTruthy();
    expect(t).toContain('факты проверены');
    expect(t).toContain('Редакция Vedar');
    const page = readFileSync('app/razreshenie-na-poseshchenie/page.tsx', 'utf-8');
    expect(page).not.toMatch(/absolute:\s*TITLE|absolute:\s*PERMIT_GUIDE_TITLE/);
    expect(page).toContain('PERMIT_GUIDE_TITLE');
    const faq = graph.find((x) => x['@type'] === 'FAQPage');
    const qs = (faq?.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>).map((q) => q.name);
    expect(qs).toEqual(permitFaq().map((f) => f.q));
    for (const f of permitFaq()) expect(t).toContain(f.a);
  });
});

describe('карточка ведёт на справку', () => {
  it('блок разрешения парка — ссылка «Кто и как выдаёт разрешения»', () => {
    const lookup: ParkLookup = { state: 'one', park: {
      slug: 'vilyuchinsky', displayName: 'Природный парк «Вилючинский»', permitUrl: PARK_PERMIT_SOURCE.url,
      email: null, officeAddress: null, officeHours: null, gosuslugiUrl: null, onlineUrl: null,
    } };
    const input = { title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' };
    const { t, links } = shot(<ParkPermitAction {...input} permit={permitCardCase(routePermitCase(input, lookup))} />);
    expect(t).toContain('Кто и как выдаёт разрешения — справка');
    expect(links).toContain(PERMIT_GUIDE_PATH);
  });

  it('Курильское озеро (Кроноцкий) — тоже', () => {
    const input = { title: 'Курильское озеро', parkName: null };
    const { links } = shot(<ParkPermitAction {...input} permit={permitCardCase(routePermitCase(input, null))} />);
    expect(links).toContain(PERMIT_GUIDE_PATH);
  });
});

describe('sitemap', () => {
  it('адрес справки в карте сайта', async () => {
    const { readFileSync } = await import('node:fs');
    // Статический список адресов — артефакт sitemap; судим по смыслу: адрес в нём есть.
    expect(readFileSync('lib/seo/sitemap-entries.ts', 'utf-8')).toContain('/razreshenie-na-poseshchenie');
  });
});
