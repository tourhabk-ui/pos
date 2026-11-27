// @vitest-environment jsdom
/**
 * Точечные правки под выгрузку GSC 18–24.11: сниппет /flights, прямой ответ
 * про царя лососей на /fish, перелинковка на уже готовые страницы.
 * Без новых адресов и без выдуманных фактов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { BRAND_SUFFIX } from '@/lib/seo/title-fit';
import { FLIGHTS_PAGE_TITLE, FLIGHTS_PAGE_DESCRIPTION } from '@/lib/seo/flights-meta';
import { FlightBoardView } from '@/components/flights/FlightBoardView';
import {
  FISH_KING_SALMON_ANSWER,
  FISH_PAGE_DATE,
  FISH_PAGE_DESCRIPTION,
  FISH_SOURCES,
  FISH_TEXT_LINKS,
  fishVisibleText,
} from '@/lib/seo/fish-page';
import { FishIndexIntro } from '@/components/fish/FishIndexAbout';
import { LANDING_CANONICAL, LANDING_CROSS_LINKS, landingBySlug, landingByPath } from '@/lib/landings/landings';
import type { PkcBoard } from '@/lib/flights/pkc-board';

const root = join(__dirname, '../..');
const BRAND = BRAND_SUFFIX;

const emptyBoard: PkcBoard = {
  fetchedAt: '2026-11-26T12:00:00Z',
  departures: { kind: 'ok', flights: [] },
  arrivals: { kind: 'ok', flights: [] },
};

describe('/flights: табло вылета и прилёта Елизово', () => {
  it('title и description совпадают с интентом табло и укладываются в пределы', () => {
    expect(FLIGHTS_PAGE_TITLE).toMatch(/Табло аэропорта Елизово/);
    expect(FLIGHTS_PAGE_TITLE).toMatch(/вылет и прилёт/);
    expect((FLIGHTS_PAGE_TITLE + BRAND).length).toBeLessThanOrEqual(60);
    expect(FLIGHTS_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(70);
    expect(FLIGHTS_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(FLIGHTS_PAGE_DESCRIPTION).toMatch(/Петропавловск-Камчатский/);
    expect(FLIGHTS_PAGE_DESCRIPTION).toMatch(/вылета и прилёта/);
    expect(FLIGHTS_PAGE_DESCRIPTION).toMatch(/по табло аэропорта/);
    expect(FLIGHTS_PAGE_DESCRIPTION + FLIGHTS_PAGE_TITLE).not.toMatch(/₽|руб|билет/);
  });

  it('лид прямо говорит, что это табло вылета и прилёта, и не обещает билеты', () => {
    render(<FlightBoardView board={emptyBoard} />);
    const lead = document.querySelector('[data-lead-answer]');
    expect(lead?.textContent).toMatch(/Онлайн-табло вылета и прилёта аэропорта Елизово/);
    expect(lead?.textContent).toMatch(/Петропавловск-Камчатский/);
    expect(lead?.textContent).toMatch(/по табло аэропорта/);
    expect(lead?.textContent).toMatch(/Причину задержки табло не называет/);
    expect(lead?.textContent).not.toMatch(/₽|руб|билет/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Табло аэропорта Елизово');
  });
});

describe('/fish: царь лососей — чавыча', () => {
  it('сниппет называет чавычу и остаётся в пределах', () => {
    expect(FISH_PAGE_DESCRIPTION).toMatch(/Царь лососей/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/чавыча/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/king salmon/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/Рыбалка на Камчатке/);
    expect(FISH_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(FISH_PAGE_DATE).toBe('2026-11-27');
  });

  it('на хабе есть прямой ответ со ссылкой на /fish/chavycha и источником NOAA', () => {
    expect(FISH_KING_SALMON_ANSWER).toMatch(/Царь лососей на Камчатке — чавыча/);
    expect(FISH_KING_SALMON_ANSWER).toMatch(/NOAA Fisheries/);
    expect(FISH_KING_SALMON_ANSWER).toMatch(/карточке чавычи/);
    expect(FISH_TEXT_LINKS.some((l) => l.href === '/fish/chavycha' && l.text === 'карточке чавычи')).toBe(true);
    expect(FISH_SOURCES.some((s) => s.href === 'https://www.fisheries.noaa.gov/species/chinook-salmon')).toBe(true);
    expect(fishVisibleText()).toContain(FISH_KING_SALMON_ANSWER);

    const html = renderToOrMarkup();
    expect(html).toContain('/fish/chavycha');
    expect(html).toMatch(/data-king-salmon-answer/);
  });
});

function renderToOrMarkup(): string {
  const { container } = render(<FishIndexIntro />);
  return container.innerHTML;
}

describe('перелинковка на готовые страницы, без ложных каноникалов', () => {
  it('старая статья «когда ехать» уже объявляет каноническим хаб, редиректа нет', () => {
    expect(LANDING_CANONICAL['/articles/kogda-luchshe-ehat-na-kamchatku']).toBe('/kogda-ehat-na-kamchatku');
    expect(LANDING_CROSS_LINKS['/articles/kogda-luchshe-ehat-na-kamchatku']?.href).toBe('/kogda-ehat-na-kamchatku');
    const config = readFileSync(join(root, 'next.config.js'), 'utf-8');
    expect(config).not.toMatch(/kogda-luchshe-ehat-na-kamchatku/);
  });

  it('хаб «когда ехать» ссылается на статью про зиму и на горячие источники', () => {
    const text = `${landingBySlug('kogda-ehat-na-kamchatku').before}\n${landingBySlug('kogda-ehat-na-kamchatku').after}`;
    expect(text).toMatch(/\[горячие источники\]\(\/articles\/goryachie-istochniki\)/);
    expect(text).toMatch(/\[статье «Зима на Камчатке»\]\(\/articles\/zima\)/);
    expect(text).toMatch(/\[Зима на Камчатке\]\(\/articles\/zima\)/);
    expect(text).toMatch(/\[Горячие источники Камчатки\]\(\/articles\/goryachie-istochniki\)/);
  });

  it('месячная страница декабря ссылается на статью про зиму контекстно и не каноникализуется на неё', () => {
    const page = landingBySlug('kamchatka-v-dekabre');
    expect(page.path).toBe('/kamchatka-v-dekabre');
    expect(page.before).toMatch(/полноценная \[зима\]\(\/articles\/zima\)/);
    expect(page.before).toMatch(/\[Термальные источники\]\(\/articles\/goryachie-istochniki\)/);
    expect(LANDING_CANONICAL['/kamchatka-v-dekabre']).toBeUndefined();
  });

  it('место и посадочная Долины гейзеров остаются разными URL и ссылаются друг на друга', () => {
    expect(landingByPath('/dolina-gejzerov-ekskursiya')?.path).toBe('/dolina-gejzerov-ekskursiya');
    expect(LANDING_CANONICAL['/places/dolina-gejzerov']).toBeUndefined();
    expect(LANDING_CANONICAL['/dolina-gejzerov-ekskursiya']).toBeUndefined();
    expect(LANDING_CROSS_LINKS['/places/dolina-gejzerov']?.href).toBe('/dolina-gejzerov-ekskursiya');
    const text = `${landingByPath('/dolina-gejzerov-ekskursiya')!.before}\n${landingByPath('/dolina-gejzerov-ekskursiya')!.after}`;
    expect(text).toMatch(/\/places\/dolina-gejzerov/);
  });
});
