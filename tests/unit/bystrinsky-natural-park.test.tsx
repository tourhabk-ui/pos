/**
 * Природный парк «Быстринский» — владелец 14.10: «так же», по образцу
 * заповедников, Вачкажца и национального парка (миграция 1246, статья
 * летописи «Природный парк „Быстринский“»).
 *
 * Держится то, что делает правку правдой:
 *  - сочинение на карточке парка («Алхалалалай» посреди стойбища, «полтора
 *    миллиона гектаров») заменяется справкой по источникам и только пока
 *    оно прежнее; тип — «Природный парк», а не «Лесной массив»;
 *  - режим «Природный парк» с правилами из источников получают места
 *    внутри контура OSM, кроме двух мест в самом селе Эссо, и только поверх
 *    прежнего режима природного парка, ЮНЕСКО, «нет» или пустоты;
 *  - «Быстринский» остаётся краевым: оговорки национального парка у его
 *    маршрутов нет, разрешение — КГБУ «Вулканы Камчатки»;
 *  - справочник парков получает каналы разрешения со страницы парка;
 *  - снимки залиты до миграции, у каждого автор и лицензия.
 * Экран судится рендером: блок режима, «Как добраться», страница парка,
 * разрешение на карточке маршрута, статья.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/agents/memory/agent-knowledge', () => ({ knowledgeBase: {} }));
vi.mock('@/lib/agents/repo-scanner', () => ({ runRepoScan: vi.fn() }));

import ChronicleArticlePage from '@/app/letopis/[slug]/page';
import ParkClient from '@/app/park/[slug]/_ParkClient';
import PlaceEco from '@/components/places/PlaceEco';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import { CHRONICLE_BY_SLUG, chronicleForPark, chronicleForPlace } from '@/lib/chronicle/articles';
import { composeAccessText } from '@/lib/places/access-text';
import { locationTypeLabel } from '@/lib/places/location-types';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { descriptionVoice } from '@/lib/places/description-voice';
import { federalizedPark, PARK_PERMIT_SOURCE } from '@/lib/safety/park-permit';
import { TOURISM_DOMAIN } from '@/lib/agents/warmup';
import type { ParkPageData } from '@/lib/parks/park-page';

afterEach(cleanup);

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1246_bystrinsky_natural_park.sql'), 'utf-8');
const ID = 'c35c5024-238f-44ec-85f6-c31127fdfffb';
const IN_ESSO = ['36d5d094-5ab0-4f06-a0de-da62bd3ab0a1', 'b2c3d4e5-f6a7-8901-bcde-f01234567890'];

/** Тело миграции без комментариев — судим то, что исполнится. */
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
/** Операторы: конец — «;» в конце строки (в текстах «;» бывает и внутри). */
const STATEMENTS = BODY.split(/;\s*\n/);

/** Склеенное значение `field = '…' || E'\n' || '…'` из оператора. */
function literalOf(stmt: string, field: string): string {
  const part = stmt.split(new RegExp(`(?<![a-z_])${field}\\s*=`))[1].split(/,\s*\n\s*[a-z_]+\s*=|\n\s*WHERE|\n\s*FROM/)[0];
  return [...part.matchAll(/E'\\n'|'((?:[^']|'')*)'/g)]
    .map((m) => (m[0] === "E'\\n'" ? '\n' : m[1].replace(/''/g, "'")))
    .join('');
}

const placeUpdates = STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${ID}'`));
const textStmt = placeUpdates.find((s) => /description\s*=/.test(s))!;
const DESCRIPTION = literalOf(textStmt, 'description');
const ESSENCE = literalOf(textStmt, 'essence');
const ACCESS = literalOf(placeUpdates.find((s) => /access_info\s*=/.test(s))!, 'access_info');
const regimeStmt = STATEMENTS.find((s) => /UPDATE places p/.test(s))!;
const RULES = literalOf(regimeStmt, 'eco_rules');
const MEMBERS = [...regimeStmt.matchAll(/\('([0-9a-f-]{36})', '((?:[^']|'')*)'\)/g)].map((m) => ({ id: m[1], name: m[2] }));
const parkStmt = STATEMENTS.find((s) => /UPDATE parks/.test(s))!;

describe('карточка парка', () => {
  it('сочинение заменяется справкой, и только пока оно прежнее', () => {
    expect(textStmt).toMatch(/AND description LIKE 'Горячие источники Эссо парят у подножия Ичинского%'/);
    expect(DESCRIPTION).toContain('1 325 тысяч');
    expect(DESCRIPTION).toContain('от 18 августа 1995 года № 192');
    expect(DESCRIPTION).toContain('Ичинская сопка — самый высокий действующий вулкан Срединного хребта');
    expect(DESCRIPTION).not.toMatch(/Алхалалала|полтора миллиона|не хозяин/);
    for (const t of [DESCRIPTION, ESSENCE, ACCESS, RULES]) expect(descriptionVoice(t).voice).toBe('plain');
  });

  it('тип — «Природный парк», район — «Центральная», оба только поверх прежних', () => {
    const type = placeUpdates.find((s) => /location_type\s*=/.test(s))!;
    expect(type).toMatch(/SET location_type = 'park'/);
    expect(type).toMatch(/AND location_type = 'forest'/);
    expect(locationTypeLabel('park')).toBe('Природный парк');
    const zone = placeUpdates.find((s) => /SET zone\s*=/.test(s))!;
    expect(zone).toMatch(/SET zone = 'central'/);
    expect(zone).toMatch(/AND zone = 'avachinsky'/);
    expect(placeZoneLabel('central')).toBe('Центральная');
  });

  it('отзыв Кузьмича про ледоруб — пустая строка, и только он', () => {
    const s = placeUpdates.find((x) => /SET kuzmich_review/.test(x))!;
    expect(s).toMatch(/kuzmich_review = ''/);
    expect(s).toMatch(/AND kuzmich_review LIKE '%без ледоруба не обойтись%'/);
  });

  it('«Как добраться»: записанное слово в слово, район словом, разрешение природного парка', () => {
    const lines = composeAccessText({
      name: 'Природный парк «Быстринский»', lat: 56.058389, lng: 158.2561944, district: null, zone: 'central',
      accessInfo: ACCESS, routes: [], registrationRequired: false,
      eco: { zone: 'natural_park', permitRequired: true }, toursCount: 0,
    });
    expect(lines[0]).toMatch(/район: Центральная\.$/);
    expect(lines).toContain(ACCESS);
    expect(lines).toContain('Посещение — по разрешению дирекции природного парка.');
  });

  it('профиль: медведи, шаблонные поля обнулены, переводится только шаблон', () => {
    const s = STATEMENTS.find((x) => /UPDATE location_safety_profile/.test(x))!;
    expect(s).toMatch(/hazard_types = ARRAY\['bears'\]/);
    for (const f of ['capacity_per_day', 'capacity_per_hour', 'optimal_group_size', 'difficulty_level', 'terrain_type', 'road_type', 'road_accessibility']) {
      expect(s, f).toMatch(new RegExp(`${f} = NULL`));
    }
    expect(s).toMatch(/profile_source = 'manual'/);
    expect(s).toMatch(/AND lsp\.profile_source = 'type_template'/);
  });
});

describe('режим мест внутри контура', () => {
  it('22 места: парк и 21 внутри контура; два места в самом Эссо не трогаются', () => {
    expect(MEMBERS).toHaveLength(22);
    expect(new Set(MEMBERS.map((m) => m.id)).size).toBe(22);
    expect(MEMBERS.map((m) => m.id)).toContain(ID);
    expect(MEMBERS.map((m) => m.name)).toEqual(expect.arrayContaining(['Ичинский Вулкан', 'Апапельские горячие источники', 'Димшиканский кордон']));
    for (const id of IN_ESSO) expect(MEMBERS.map((m) => m.id)).not.toContain(id);
  });

  it('режим ложится только поверх природного парка, ЮНЕСКО, «нет» или пустоты', () => {
    expect(regimeStmt).toMatch(/eco_zone = 'natural_park'/);
    expect(regimeStmt).toMatch(/eco_permit_required = TRUE/);
    expect(literalOf(regimeStmt, 'eco_permit_url')).toBe(PARK_PERMIT_SOURCE.url);
    expect(regimeStmt).toMatch(/AND \(p\.eco_zone IS NULL OR p\.eco_zone IN \('none', 'natural_park', 'UNESCO'\)\)/);
    expect(regimeStmt).not.toMatch(/'federal_reserve'|'nature_monument'|'national_park'|'zakaznik'/);
  });

  it('блок режима: «Природный парк», две строки правил целиком, ссылка на страницу парка', () => {
    render(<PlaceEco eco={{ zone: 'natural_park', permitRequired: true, rules: RULES, permitUrl: PARK_PERMIT_SOURCE.url }} placeName="Озеро Икар" />);
    expect(screen.getByText('Природный парк')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^Посещение — по разрешению КГБУ/);
    expect(items[0]).toContain('«Зелёная кнопка»');
    expect(items[0]).toContain('(улица Ленина, 8)');
    expect(items[0]).toContain('(улица Завойко, 33)');
    expect(items[1]).toMatch(/не в заказнике «Ичинский»/);
    expect(screen.getByRole('link', { name: /Оформить пропуск/ }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
  });

  it('«Быстринский» не национальный парк: оговорки о переходе у его маршрутов нет', () => {
    expect(federalizedPark('Быстринский', 'Эко-тропа Тупикин ключ')).toBeNull();
    render(<ParkPermitAction title="Тупикин ключ" parkName="Природный парк «Быстринский»" />);
    expect(document.body.textContent).not.toMatch(/национальный парк/i);
    expect(screen.getAllByRole('link', { name: /Android/ }).length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/ТИЦ в Эссо/);
  });

  it('Кузьмич знает, что в «Быстринский» нужен пропуск', () => {
    const line = TOURISM_DOMAIN.split('\n').find((l) => l.startsWith('- Нужен пропуск'))!;
    expect(line).toMatch(/«Быстринский»/);
  });
});

describe('справочник парков', () => {
  const park: ParkPageData = {
    slug: 'bystrinskiy',
    displayName: 'Природный парк «Быстринский»',
    description: literalOf(parkStmt, 'description'),
    zone: 'northern',
    permit_url: literalOf(parkStmt, 'permit_url'),
    permitChannels: {
      email: literalOf(parkStmt, 'permit_email'),
      officeAddress: literalOf(parkStmt, 'permit_office_address'),
      officeHours: literalOf(parkStmt, 'permit_office_hours'),
      gosuslugiUrl: literalOf(parkStmt, 'permit_gosuslugi_url'),
      onlineUrl: null,
    },
    routes: [],
    routesFailed: false,
  };

  it('правится только прежняя однострочная запись', () => {
    expect(parkStmt).toMatch(/WHERE slug = 'bystrinskiy'/);
    expect(parkStmt).toMatch(/AND description = 'Самый большой природный парк Камчатки\. Центральная Камчатка, долина реки Быстрой, медведи, нетронутая тайга\.'/);
  });

  it('страница парка: род, «Получить» — на страницу парка о разрешениях, каналы со страницы парка', () => {
    render(<ParkClient park={park} />);
    expect(document.body.textContent).toMatch(/Природный парк · Камчатка/);
    expect(screen.getByRole('link', { name: 'Получить' }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
    expect(document.body.textContent).toMatch(/Офис: село Эссо, улица Ленина, 8 — туристский информационный центр парка/);
    expect(document.body.textContent).toMatch(/ежедневно 9:00–18:00, перерыв 13:00–14:00/);
    expect(screen.getByRole('link', { name: 'visit@park-vulcany.ru' }).getAttribute('href')).toBe('mailto:visit@park-vulcany.ru');
    expect(screen.getByRole('link', { name: /Госуслуги 41/ }).getAttribute('href')).toBe('https://gosuslugi41.ru/pgu/volcano_info.htm');
    expect(descriptionVoice(park.description ?? '').voice).toBe('plain');
  });
});

describe('снимки 1246', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    items: Array<{ key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'(photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];

  it('главный кадр и шесть снимков галереи, все залиты media-to-s3 до миграции', () => {
    expect(keys).toHaveLength(7);
    const uploaded = new Set(marker.items.map((i) => i.key));
    for (const k of keys) expect(uploaded.has(k), k).toBe(true);
    expect(keys).not.toContain('photos/bystrinsky/dordon-dalnij.jpg');
  });

  it('у каждого снимка автор, свободная лицензия и страница Commons', () => {
    expect((BODY.match(/'CC BY-SA [34]\.0'/g) ?? []).length).toBe(7);
    expect((BODY.match(/'https:\/\/commons\.wikimedia\.org\/wiki\/File:/g) ?? []).length).toBe(7);
  });

  it('галерея встаёт после снимков места, тот же снимок второй раз не ложится', () => {
    const gallery = STATEMENTS.find((s) => /INSERT INTO place_gallery_photos/.test(s))!;
    expect(gallery).toMatch(/COALESCE\(\(SELECT max\(g\.position\) FROM place_gallery_photos g WHERE g\.ark_id = p\.ark_id\), 0\) \+ s\.ord/);
    expect(gallery).toMatch(/NOT EXISTS \(SELECT 1 FROM place_gallery_photos g\s+WHERE g\.ark_id = p\.ark_id AND g\.s3_key = s\.s3_key\)/);
  });
});

describe('статья «Природный парк „Быстринский“»', () => {
  const SLUG = 'bystrinskij-park';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const text = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточкой места и страницей парка', () => {
    expect(chronicleForPlace(ID).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('bystrinskiy').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toEqual(['/places/prirodnyj-park-bystrinskij', '/park/bystrinskiy']);
  });

  it('каждая веха — в тексте, годы по порядку; постановления названы с датами', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(text).toContain('от 18 августа 1995 года № 192');
    expect(text).toContain('5 июля 1996 года, постановлением № 186');
  });

  it('устаревшее и неподтверждённое не утверждается', () => {
    // «самая большая ООПТ Дальнего Востока» — справочник 2013 года, до
    // национального парка «Командорские острова» (3,65 млн га, 2022).
    expect(text).not.toMatch(/Дальнего Востока/);
    expect(text).not.toMatch(/национальн\S* парк\S* «Быстринск/);
    expect(text).toMatch(/«Быстринский» в него не вошёл/);
  });

  it('страница: главный кадр с автором и лицензией, лента дат, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Природный парк «Быстринский»');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/bystrinsky/oleni.jpg');
    const figure = img.closest('figure')!;
    expect(within(figure).getByRole('link', { name: 'NadezhdaKhaustova' }).getAttribute('href')).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    const dates = screen.getByRole('region', { name: 'Главные даты' });
    expect(within(dates).getAllByRole('listitem')).toHaveLength(article.timeline!.length);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
  });

  it('главный кадр залит в хранилище', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ key: string }>;
    };
    expect(marker.items.map((i) => i.key)).toContain(article.hero!.key);
  });
});
