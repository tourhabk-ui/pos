// @vitest-environment jsdom
/**
 * Быстрые победы по GSC 18–24.11 (Сыщик 28.11, слово владельца «да, делай все три»):
 *  1. /flights — постоянный текст под табло, виден и при пустом/непрочитанном табло;
 *  2. восемь мест — сниппеты по фактам карточки, без подписи зоны «Авачинский»;
 *  3. Кроноцкое озеро — ответ «где находится» с источником и блок «на карте»;
 *     /fish — описание ~125 знаков.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { FlightBoardView } from '@/components/flights/FlightBoardView';
import type { PkcBoard } from '@/lib/flights/pkc-board';
import {
  flightsAirportJsonLd, FLIGHTS_AIRPORT_ICAO, FLIGHTS_AIRPORT_IATA, FLIGHTS_ABOUT_SOURCES,
} from '@/lib/seo/flights-about';
import { PLACE_SEARCH_META } from '@/lib/seo/place-search-meta';
import { PlaceMapNote } from '@/components/places/PlaceMapNote';
import { FISH_PAGE_DESCRIPTION } from '@/lib/seo/fish-page';

afterEach(cleanup);

const BRAND = ' | Ведар';
const NOW = '2026-11-28T05:00:00Z';

describe('/flights: постоянный текст под табло', () => {
  const empty: PkcBoard = { departures: { kind: 'ok', flights: [] }, arrivals: { kind: 'ok', flights: [] }, fetchedAt: NOW };
  const failed: PkcBoard = {
    departures: { kind: 'failed', reason: 'сайт аэропорта не ответил (timeout)' },
    arrivals: { kind: 'failed', reason: 'сайт аэропорта не ответил (timeout)' },
    fetchedAt: NOW,
  };

  for (const [name, board] of [['табло пусто', empty], ['табло не прочиталось', failed]] as const) {
    it(`${name}: блок на месте, с кодами, 29 км и источниками`, () => {
      const { container } = render(<FlightBoardView board={board} />);
      const about = container.querySelector('[data-flights-about]');
      expect(about).toBeTruthy();
      const text = about!.textContent ?? '';
      expect(text).toContain('PKC');
      expect(text).toContain('UHPP');
      expect(text).toContain('29 км');
      expect(text).toContain('UTC+12');
      expect(text.split(/\s+/).length).toBeGreaterThan(120);
      expect(text).not.toMatch(/₽|руб/);
      const hrefs = [...about!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(expect.arrayContaining(['/weather', '/safety', '/raznica-vo-vremeni-kamchatka-moskva']));
      for (const s of FLIGHTS_ABOUT_SOURCES) expect(hrefs).toContain(s.href);
    });
  }

  it('блок стоит ПОСЛЕ задержек, вылета, прилёта и источника — табло не сдвинуто', () => {
    const { container } = render(<FlightBoardView board={empty} />);
    const about = container.querySelector('[data-flights-about]')!;
    const before = [
      screen.getByRole('region', { name: 'Задержки и отмены' }),
      screen.getByRole('region', { name: 'Вылет' }),
      screen.getByRole('region', { name: 'Прилёт' }),
      screen.getByRole('link', { name: /табло на сайте аэропорта/ }),
    ];
    for (const el of before) {
      expect(el.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Первый экран прежний: H1 и лид-ответ — первые на странице.
    expect(container.querySelector('h1')!.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('разметка Airport повторяет видимый текст', () => {
    const ld = flightsAirportJsonLd() as Record<string, unknown>;
    expect(ld['@type']).toBe('Airport');
    expect(ld.iataCode).toBe(FLIGHTS_AIRPORT_IATA);
    expect(ld.icaoCode).toBe(FLIGHTS_AIRPORT_ICAO);
    const { container } = render(<FlightBoardView board={empty} />);
    const text = container.textContent ?? '';
    expect(text).toContain(String(ld.iataCode));
    expect(text).toContain(String(ld.icaoCode));
    expect(text).toContain('Елизово');
    expect(text).toContain('Камчатского края');
  });
});

describe('восемь мест из GSC 18–24.11: сниппеты по фактам карточки', () => {
  const SLUGS = [
    'vulkan-ksudach',
    'vulkan-kronotskij-kronotskaya-sopka',
    'razdolie-kamchatki',
    'zelenovskie-ozerki',
    'vulkan-hodutka-zateryannyj-mir',
    'ozero-bolshoj-kalygir',
    'koryakskaya-sopka',
    'kozelskij',
  ];

  it('записи есть; title с брендом ≤ 60, description ≤ 160, без цен', () => {
    for (const slug of SLUGS) {
      const m = PLACE_SEARCH_META[slug];
      expect(m, slug).toBeTruthy();
      expect((m.title + BRAND).length, slug).toBeLessThanOrEqual(60);
      expect(m.description.length, slug).toBeLessThanOrEqual(160);
      for (const s of [m.title, m.description]) expect(s, slug).not.toMatch(/₽|руб/);
    }
  });

  it('подписи зоны «…на Камчатке, Авачинский» в сниппете нет; расстояние названо «по прямой»', () => {
    for (const slug of SLUGS) {
      const d = PLACE_SEARCH_META[slug].description;
      expect(d, slug).not.toMatch(/на Камчатке, Авачинский/);
      expect(d, slug).toMatch(/по прямой/);
      expect(d, slug).toMatch(/Петропавловск/);
    }
    // «Авачинским» в Козельском — сосед-вулкан из карточки («Вулкан Авачинский — 5 км»), не район.
    for (const slug of SLUGS.filter((x) => x !== 'kozelskij')) {
      expect(PLACE_SEARCH_META[slug].description, slug).not.toMatch(/Авачинск/);
    }
  });

  it('числа совпадают с карточками на 28.11', () => {
    expect(PLACE_SEARCH_META['vulkan-ksudach'].description).toMatch(/1079 м.*153 км.*юго-западу/);
    expect(PLACE_SEARCH_META['vulkan-kronotskij-kronotskaya-sopka'].description).toMatch(/230 км.*северо-востоку/);
    expect(PLACE_SEARCH_META['razdolie-kamchatki'].description).toMatch(/37 км.*северо-западу.*№ 23/);
    expect(PLACE_SEARCH_META['zelenovskie-ozerki'].description).toMatch(/37 км.*северо-западу/);
    expect(PLACE_SEARCH_META['vulkan-hodutka-zateryannyj-mir'].description).toMatch(/2090 м.*123 км.*юго-западу/);
    expect(PLACE_SEARCH_META['ozero-bolshoj-kalygir'].description).toMatch(/95 км.*северо-востоку/);
    expect(PLACE_SEARCH_META['koryakskaya-sopka'].description).toMatch(/35 км.*северу.*8,2 км/);
    expect(PLACE_SEARCH_META.kozelskij.description).toMatch(/29 км.*северо-востоку/);
  });

  it('названия мест не изменены', () => {
    expect(PLACE_SEARCH_META['vulkan-ksudach'].title).toMatch(/Ксудач/);
    expect(PLACE_SEARCH_META['vulkan-kronotskij-kronotskaya-sopka'].title).toMatch(/Кроноцкий \(Кроноцкая сопка\)/);
    expect(PLACE_SEARCH_META['razdolie-kamchatki'].title).toMatch(/^Раздолье Камчатки/);
    expect(PLACE_SEARCH_META['zelenovskie-ozerki'].title).toMatch(/^Зеленовские озерки/);
    expect(PLACE_SEARCH_META['vulkan-hodutka-zateryannyj-mir'].title).toMatch(/Ходутка/);
    expect(PLACE_SEARCH_META['ozero-bolshoj-kalygir'].title).toMatch(/Большой Калыгирь/);
    expect(PLACE_SEARCH_META['koryakskaya-sopka'].title).toMatch(/Корякская сопка/);
    expect(PLACE_SEARCH_META.kozelskij.title).toMatch(/Козельский/);
  });
});

describe('Кроноцкое озеро: «где находится» с источником и блок «на карте»', () => {
  const k = PLACE_SEARCH_META['ozero-kronotskoe'];

  it('ответ называет заповедник и Долину гейзеров и ссылается на источник', () => {
    expect(k.leadAnswer?.text).toMatch(/Кроноцкого заповедника/);
    expect(k.leadAnswer?.text).toMatch(/30 км к северу от Долины гейзеров/);
    expect(k.leadAnswer?.source.url).toMatch(/^https:\/\/ru\.wikipedia\.org\//);
  });

  it('прежний сниппет не тронут', () => {
    expect(k.title).toMatch(/245 км²/);
    expect(k.description).toMatch(/Долины гейзеров/);
    expect(k.description).toMatch(/разрешен/);
  });

  it('блок «на карте»: координата, прямое расстояние, ссылка на /map?place=, источник заповедника', () => {
    expect(k.mapNote?.source.url).toMatch(/^https:\/\/kronoki\.ru\//);
    const { container } = render(
      <PlaceMapNote name="Озеро Кроноцкое" lat={54.813806} lng={160.218} mapRef="ozero-kronotskoe" note={k.mapNote!} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Озеро Кроноцкое на карте');
    expect(text).toContain('54.814, 160.218');
    expect(text).toMatch(/22\d км по прямой/);
    expect(text).toContain('Откуда снята координата, у нас не записано');
    // Источник пишет «до Кроноцкого заповедника – вертолётом»: так и сказано, без «до него».
    expect(text).toContain('до Кроноцкого заповедника, где лежит озеро, добираются вертолётом');
    expect(text).not.toContain('до него');
    expect(screen.getByRole('link', { name: 'Открыть место на карте Ведара' }).getAttribute('href')).toBe('/map?place=ozero-kronotskoe');
    expect(text).not.toMatch(/₽|руб/);
  });

  it('карточка передаёт mapNote только у мест из списка, у посадочной — нет', () => {
    const page = require('node:fs').readFileSync('app/places/[id]/page.tsx', 'utf8') as string;
    expect(page).toMatch(/const mapNote = landing \? null : \(placeSearchMeta\(canonicalId\)\?\.mapNote \?\? null\)/);
    expect(page).toMatch(/mapNote=\{mapNote\} mapRef=\{canonicalId\}/);
  });
});

describe('/fish: description около 125 знаков', () => {
  it('короче прежних 146, держит «Царь лососей», «чавыча», «king salmon», «путёвк»', () => {
    expect(FISH_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(115);
    expect(FISH_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(130);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/Царь лососей/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/чавыча/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/king salmon/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/Рыбалка на Камчатке/);
    expect(FISH_PAGE_DESCRIPTION).toMatch(/путёвк/);
  });
});
