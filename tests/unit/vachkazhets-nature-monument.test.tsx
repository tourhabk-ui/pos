/**
 * Памятник природы «Вачкажец» — владелец 14.10: «тоже делаем по примерам»
 * (миграция 1244, статья летописи «Вачкажец»).
 *
 * Держится то, что делает правку правдой:
 *  - разрешения у Вачкажца нет: положение об охранной зоне его не
 *    предусматривает (Минприроды 2019, Служба по охране животного мира 2023),
 *    и ни справочник парков, ни карточка маршрута не зовут за ним в «Зелёную
 *    кнопку» парка, в который Вачкажец не входит;
 *  - «памятник природы» — режим охраны, а тип места остаётся «гора»;
 *  - выдуманный отзыв Кузьмича («базальтовый разлом», «айсберги») снимается,
 *    а пустая строка не даёт агенту написать новый;
 *  - профиль безопасности переводится из шаблона целиком, без шаблонных
 *    «фактов»;
 *  - снимки залиты до миграции, у каждого автор и лицензия.
 * Экран судится рендером: блок режима, «Как добраться», разрешение на
 * карточке маршрута, статья.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import ChronicleArticlePage from '@/app/letopis/[slug]/page';
import PlaceEco from '@/components/places/PlaceEco';
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import MchsRegistrationBlock from '@/components/safety/MchsRegistrationBlock';
import { CHRONICLE_BY_SLUG, chronicleForPark, chronicleForPlace } from '@/lib/chronicle/articles';
import { composeAccessText } from '@/lib/places/access-text';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { noPermitTerritory } from '@/lib/safety/park-permit';
import { descriptionVoice } from '@/lib/places/description-voice';
import { routeFacts } from '@/lib/ai/route-knowledge';
import { buildFacts } from '@/lib/agents/editor';

afterEach(cleanup);

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1244_vachkazhets_nature_monument.sql'), 'utf-8');
const ID = 'c4310d06-2b6c-4b6e-af3a-b0c7cd678ebe';

/** Тело миграции без комментариев — судим то, что исполнится. */
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
/** Операторы: конец — «;» в конце строки (в текстах «;» бывает и внутри). */
const STATEMENTS = BODY.split(/;\s*\n/);

/** Склеенное значение `field = '…' || E'\n' || '…'` из оператора. */
function literalOf(stmt: string, field: string): string {
  const part = stmt.split(new RegExp(`${field}\\s*=`))[1].split(/,\s*\n\s*[a-z_]+\s*=|\n\s*WHERE/)[0];
  return [...part.matchAll(/E'\\n'|'((?:[^']|'')*)'/g)]
    .map((m) => (m[0] === "E'\\n'" ? '\n' : m[1].replace(/''/g, "'")))
    .join('');
}

const placeUpdates = STATEMENTS.filter((s) => /UPDATE places/.test(s) && s.includes(`'${ID}'`));
const ecoStmt = placeUpdates.find((s) => /eco_rules\s*=/.test(s))!;
const RULES = literalOf(ecoStmt, 'eco_rules');
const ACCESS = literalOf(placeUpdates.find((s) => /access_info\s*=/.test(s))!, 'access_info');

describe('режим: памятник природы без разрешения', () => {
  it('режим ложится только в пустой, разрешение — «нет», ссылки разрешения нет', () => {
    expect(ecoStmt).toMatch(/eco_zone = 'nature_monument'/);
    expect(ecoStmt).toMatch(/eco_permit_required = FALSE/);
    expect(ecoStmt).toMatch(/eco_permit_url = NULL/);
    expect(ecoStmt).toMatch(/AND eco_zone IS NULL/);
  });

  it('тип места не меняется: массив остаётся горой', () => {
    expect(BODY).not.toMatch(/location_type\s*=/);
  });

  it('блок режима: памятник природы, правила по одному, без «Нужен пропуск»', () => {
    render(<PlaceEco eco={{ zone: 'nature_monument', permitRequired: false, rules: RULES, permitUrl: null }} placeName="Вачкажец" />);
    expect(screen.getByText('Памятник природы')).toBeTruthy();
    expect(document.body.textContent).toMatch(/охранной зоне, если она установлена/);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    expect(items[0]).toMatch(/^Разрешение на посещение не нужно/);
    expect(items[0]).toContain('№ 93 от 07.11.2018');
    expect(items[1]).toMatch(/информационный щит/);
    expect(document.body.textContent).not.toMatch(/Нужен пропуск|Требуется разрешение/);
  });

  it('«Как добраться»: записанное слово в слово и строка о режиме без разрешения', () => {
    const lines = composeAccessText({
      name: 'Вачкажец', lat: 53.081266, lng: 157.931256, district: null, zone: 'western',
      accessInfo: ACCESS, routes: [], registrationRequired: false,
      eco: { zone: 'nature_monument', permitRequired: false }, toursCount: 0,
    });
    expect(lines).toContain(ACCESS);
    expect(lines).toContain('Место на территории памятника природы.');
    expect(lines.join(' ')).not.toMatch(/по разрешению/);
  });

  it('справочник парков: «требует разрешения» исправляется только в прежнем тексте', () => {
    const park = STATEMENTS.find((s) => /UPDATE parks/.test(s))!;
    expect(park).toMatch(/WHERE slug = 'vachkazhets'/);
    expect(park).toMatch(/description LIKE '%посещение требует отдельного разрешения%'/);
    expect(literalOf(park, 'description')).toMatch(/Разрешение на посещение не нужно/);
  });

  it('подпись страницы парка — «Памятник природы», а не «Природный парк»', () => {
    expect(parkKindLabel('Памятник природы «Вачкажец»')).toBe('Памятник природы');
    expect(parkKindLabel('Природный парк «Налычево»')).toBe('Природный парк');
  });
});

describe('карточка маршрута: за разрешением не зовёт', () => {
  it('маршрут массива — «не требуется» с ведомством и годом, без «Зелёной кнопки»', () => {
    render(<ParkPermitAction title="Горный массив Вачкажец (лыжный)" parkName="Вачкажец" />);
    expect(document.body.textContent).toMatch(/Разрешение на посещение не требуется/);
    expect(document.body.textContent).toMatch(/памятник природы «Горный массив Вачкажец»/);
    const src = screen.getByRole('link', { name: /Минприроды Камчатского края/ });
    expect(src.getAttribute('href')).toBe('https://kamchatkamedia.ru/news/1530036/');
    expect(screen.queryByRole('link', { name: /Android|iPhone/ })).toBeNull();
  });

  it('у парка «Вулканы Камчатки» всё по-прежнему: Зелёная кнопка на месте', () => {
    expect(noPermitTerritory('Вулкан Горелый')).toBeNull();
    render(<ParkPermitAction title="Вулкан Горелый" />);
    expect(screen.getAllByRole('link', { name: /Android/ }).length).toBeGreaterThan(0);
  });

  it('факты для Кузьмича и Editor не называют памятник «природным парком»', () => {
    const facts = routeFacts({
      difficulty: null, distance_km: null, elevation_gain_m: null, duration_hours: null, season: null,
      hazards: null, equipment: null, mchs_registration_required: null, mchs_phone: null, park_name: 'Вачкажец',
    });
    expect(facts).toContain('Охраняемая территория: Вачкажец');
    const editor = buildFacts({
      id: 'r', title: 'Горный массив Вачкажец (лыжный)', description: null, category: null, kind: 'route',
      lat: null, lng: null, location_type: null, activity_type: null, zone: null, source_name: null,
      altitude_m: null, terrain_type: null, hazard_types: null, difficulty_level: null, nearest_medical_km: null,
      distance_km: null, elevation_gain_m: null, duration_hours: null, season: null, route_type: null,
      hazards: null, equipment: null, park_name: 'Вачкажец',
    });
    expect(editor).toContain('охраняемая территория: Вачкажец');
    expect([...facts, ...editor].join('\n')).not.toMatch(/природный парк/i);
  });

  it('блок МЧС не называет памятник «природным парком»', () => {
    render(<MchsRegistrationBlock parkName="Вачкажец" parkSlug="vachkazhets" onOpenForm={() => {}} />);
    expect(document.body.textContent).toMatch(/Охраняемая территория:\s*Вачкажец/);
    expect(document.body.textContent).not.toMatch(/Природный парк:/);
  });
});

describe('отзыв Кузьмича и профиль безопасности', () => {
  it('выдуманный отзыв — пустая строка, и только пока он прежний', () => {
    const s = placeUpdates.find((x) => /kuzmich_review/.test(x))!;
    expect(s).toMatch(/kuzmich_review = ''/);
    expect(s).toMatch(/kuzmich_review LIKE '%базальтовый разлом%'/);
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

  it('тексты места — голос справки', () => {
    for (const t of [RULES, ACCESS, literalOf(placeUpdates.find((x) => /essence\s*=/.test(x))!, 'essence')]) {
      expect(descriptionVoice(t).voice).toBe('plain');
    }
  });

  it('источник записи помещается в колонку и пишется только в пустую', () => {
    const s = placeUpdates.find((x) => /source_name\s*=/.test(x))!;
    expect(literalOf(s, 'source_name').length).toBeLessThanOrEqual(100);
    expect(s).toMatch(/source_name IS NULL AND source_url IS NULL/);
  });
});

describe('снимки 1244', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    items: Array<{ key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'(photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];

  it('четыре ключа, все залиты media-to-s3 до миграции; позиции после снимков Гусаковой', () => {
    expect(keys).toHaveLength(4);
    const uploaded = new Set(marker.items.map((i) => i.key));
    for (const k of keys) expect(uploaded.has(k), k).toBe(true);
    expect(BODY).toMatch(/\(10, 1600, 1200, 'Гора Вачкажец'/);
    expect(BODY).toMatch(/ON CONFLICT \(ark_id, position\) DO NOTHING/);
  });

  it('у каждого снимка автор, свободная лицензия и страница Commons', () => {
    expect((BODY.match(/'CC BY-SA 4\.0'/g) ?? []).length).toBe(4);
    expect((BODY.match(/'https:\/\/commons\.wikimedia\.org\/wiki\/File:/g) ?? []).length).toBe(4);
  });
});

describe('статья «Вачкажец»', () => {
  const SLUG = 'vachkazhets';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const text = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточкой места и страницей памятника', () => {
    expect(chronicleForPlace(ID).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('vachkazhets').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toEqual(['/places/vachkazhets', '/park/vachkazhets']);
  });

  it('каждая веха — в тексте, годы по порядку; дата создания и номер постановления названы', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(text).toContain('9 января 1981 года');
    expect(text).toContain('№ 93 от 7 ноября 2018 года');
  });

  it('разрешения статья не обещает и опровергнутую версию называет опровергнутой', () => {
    expect(text).toMatch(/Разрешения на посещение положение об охранной зоне не предусматривает/);
    expect(text).toMatch(/Спор закончился в XXI веке в пользу тектонического происхождения/);
  });

  it('страница: главный кадр с автором и лицензией, лента дат, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Вачкажец');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/vachkazhets/gora-vachkazhets-zimoj.jpg');
    const figure = img.closest('figure')!;
    expect(within(figure).getByRole('link', { name: 'Michael Haing' }).getAttribute('href')).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
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
