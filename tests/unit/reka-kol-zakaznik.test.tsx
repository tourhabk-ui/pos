/**
 * Лососевый заказник «Река Коль» (14.10, владелец: «Бери по порядку схему»;
 * миграция 1255).
 *
 * Заказник с 2015 года — часть сети «Вулканы Камчатки», но на платформе его не
 * было вовсе. Источник — раздел заказника на сайте КГБУ (пробы 906, 908).
 *
 * Держится то, что делает правку правдой:
 *  - тип «Заказник», западное побережье, порядок посещения — разрешение из
 *    офиса КГБУ, а не «Зелёная кнопка» и не заявка в Кроноцкий заповедник;
 *  - тексты — по сайту КГБУ, голос справки; где источники расходятся (длина
 *    Коли), названы оба числа;
 *  - своих и партнёрских снимков нет — и чужих не поставлено;
 *  - корень справочника не цепляет «Кольцевой» и «Николаевку».
 * Экран судится рендером: блок режима и статья летописи.
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
import PlaceEco from '@/components/places/PlaceEco';
import { CHRONICLE_BY_SLUG, chronicleForPark, chronicleForPlace } from '@/lib/chronicle/articles';
import { locationTypeLabel } from '@/lib/places/location-types';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { descriptionVoice } from '@/lib/places/description-voice';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { slugify } from '@/lib/text/slugify';
import { migrationBody, migrationStatements, insertValues, splitTop, valueOf } from '../helpers/migration-sql';

afterEach(cleanup);

const text = () => document.body.textContent ?? '';

const BODY = migrationBody(readFileSync(join(process.cwd(), 'migrations/1255_reka_kol_zakaznik.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);
const CARD = '8e450222-08d2-4521-a9ac-9c287b3503d4';
const RULES_URL = 'https://vulcanikamchatki.ru/territoriya/klaster_kol/rules/';

const placeInsert = STATEMENTS.find((s) => /INSERT INTO places \(/.test(s))!;
const CARD_ROW = insertValues(placeInsert);
const parkInsert = STATEMENTS.find((s) => /INSERT INTO parks/.test(s))!;
const PARK_COLS = parkInsert.split(/INSERT INTO parks \(/)[1].split(')')[0].split(',').map((c) => c.trim());
const PARK = Object.fromEntries(
  splitTop(parkInsert.split(/VALUES\s*\(/)[1].replace(/\)\s*ON CONFLICT[\s\S]*$/, '')).map((v, i) => [PARK_COLS[i], valueOf(v)]),
) as Record<string, string | null>;

describe('Лососевый заказник «Река Коль» — новая карточка', () => {
  it('новый id, тип «Заказник», западное побережье, точка на русле Коли', () => {
    expect(CARD_ROW.id).toBe(CARD);
    expect(CARD_ROW.name).toBe('Лососевый заказник «Река Коль»');
    expect(locationTypeLabel(CARD_ROW.location_type!)).toBe('Заказник');
    expect(placeZoneLabel(CARD_ROW.zone)).toBe('Западное побережье');
    expect([CARD_ROW.lat, CARD_ROW.lng]).toEqual(['53.7738832', '156.3963188']);
    expect(CARD_ROW.coord_source).toBe('external');
    expect(CARD_ROW.kuzmich_review).toBe('');
  });

  it('заводится, только если живого заказника с этим именем нет; карточка реки его не блокирует', () => {
    expect(placeInsert).toMatch(/WHERE NOT EXISTS \([\s\S]*q\.merged_into_id IS NULL[\s\S]*'лососевый заказник «река коль»'/);
    expect(placeInsert).not.toMatch(/'река коль'/);
    expect(placeInsert).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('адрес статьи летописи совпадает с адресом, который даёт миграция', () => {
    expect(BODY).toMatch(/SET slug = translit_ru_slug\(p\.name\)\s+WHERE p\.id::text = '8e450222/);
    expect(slugify(CARD_ROW.name!)).toBe('lososevyj-zakaznik-reka-kol');
  });

  it('профиль: медведи — фоновый вид хищных; выдуманных умолчаний нет', () => {
    const profile = STATEMENTS.find((s) => /INSERT INTO location_safety_profile/.test(s))!;
    expect(profile).toMatch(/ARRAY\['bears'\]::text\[\], FALSE, 'manual'/);
    expect(profile).toMatch(/SELECT p\.ark_id, NULL, NULL, NULL,\s+NULL, NULL, NULL, NULL,/);
  });

  it('своих и партнёрских снимков нет — и чужих не поставлено', () => {
    expect(BODY).not.toMatch(/ai_route_images|place_gallery_photos|commons\.wikimedia\.org/);
  });
});

describe('режим и тексты', () => {
  it('блок режима: «Государственный заказник», шесть правил по сайту КГБУ, ссылка на правила заказника', () => {
    expect(CARD_ROW.eco_zone).toBe('zakaznik');
    expect(CARD_ROW.eco_permit_url).toBe(RULES_URL);
    render(<PlaceEco eco={{ zone: 'zakaznik', permitRequired: true, rules: CARD_ROW.eco_rules, permitUrl: RULES_URL }} placeName="Лососевый заказник «Река Коль»" />);
    expect(screen.getByText('Государственный заказник')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    expect(items[0]).toMatch(/^Государственный экспериментальный биологический \(лососевый\) заказник регионального значения «Река Коль» — с 2006 года/);
    expect(items[1]).toMatch(/офиса КГБУ «Природный парк „Вулканы Камчатки“» в Елизово \(улица Завойко, 33\)/);
    expect(items[3]).toMatch(/с 1 июня по 1 сентября/);
    expect(items[4]).toMatch(/^В зоне особой охраны «Среднее течение реки Кехта» круглый год запрещены вылов любых рыб/);
    expect(screen.getByRole('link', { name: 'Как получить разрешение' }).getAttribute('href')).toBe(RULES_URL);
    // Не приложение краевых парков: у заказника своя страница правил.
    expect(text()).not.toMatch(/Зелёная кнопка/);
  });

  it('голос справки у описания, сути, «как добраться» и справочника', () => {
    for (const t of [CARD_ROW.description, CARD_ROW.essence, CARD_ROW.access_info, PARK.description]) {
      expect(t).toBeTruthy();
      expect(descriptionVoice(t).voice, t!.slice(0, 60)).toBe('plain');
    }
  });

  it('числа — из источника; длина Коли — обоими числами, а не удобным', () => {
    expect(CARD_ROW.description).toMatch(/220 605,64 гектара/);
    expect(CARD_ROW.description).toMatch(/25 апреля 2006 года № 206/);
    expect(CARD_ROW.description).toMatch(/около 130 километров по данным дирекции заказника \(Википедия называет 122\)/);
  });
});

describe('справочник парков: страница заказника', () => {
  it('«Заказник» над заголовком, правила и офис КГБУ, включена', () => {
    expect(PARK.slug).toBe('reka-kol');
    expect(parkKindLabel(PARK.display_name!)).toBe('Заказник');
    expect(PARK.permit_url).toBe(RULES_URL);
    expect(PARK.permit_office_address).toMatch(/Завойко, 33/);
    expect(PARK.is_active).toBe('TRUE');
    expect(parkInsert).toMatch(/ON CONFLICT \(slug\) DO NOTHING/);
  });

  it('корень «Река Коль» не цепляет «Кольцевой» и «Николаевку»', () => {
    const term = PARK.search_term!.toLowerCase();
    const hit = (s: string) => s.toLowerCase().includes(term);
    expect(hit('Лососевый заказник «Река Коль»')).toBe(true);
    expect(hit('Кольцевой маршрут вокруг Авачинского')).toBe(false);
    expect(hit('Николаевка')).toBe(false);
  });
});

describe('статья «Лососевый заказник «Река Коль»»', () => {
  const SLUG = 'reka-kol';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const all = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточкой заказника и его страницей', () => {
    expect(chronicleForPlace(CARD).map((a) => a.slug)).toEqual([SLUG]);
    expect(chronicleForPark('reka-kol').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toContain(`/places/${slugify(CARD_ROW.name!)}`);
  });

  it('каждая веха — в тексте, годы по порядку; без главного кадра — снимков нет', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(all).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(article.hero).toBeUndefined();
  });

  it('страница: заголовок, источники, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Лососевый заказник «Река Коль»');
    expect(text()).toMatch(/Коль \(река, впадает в Охотское море\)/);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      (article.links ?? []).map((l) => l.href),
    );
  });
});
