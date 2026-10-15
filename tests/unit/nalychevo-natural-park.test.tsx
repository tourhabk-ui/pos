/**
 * Природный парк «Налычево» — владелец 14.10: «Природный парк „Налычево“
 * го», по образцу «Быстринского» (миграция 1248, статья летописи).
 *
 * Держится то, что делает правку правдой:
 *  - впечатления на карточках парка и Налычевских источников уходят в архив,
 *    на их месте — справка по источникам, и только пока текст прежний;
 *    пустая после 1247 долина получает справку; числа, в которых источники
 *    расходятся, карточка не называет;
 *  - тип — «Природный парк», точка — центр контура OSM вместо заглушки;
 *  - режим «Природный парк» с разрешением — двадцати местам внутри контура,
 *    без разрешения — территории Авачинского перевала (сам перевал и
 *    Верблюд): так говорит страница парка о разрешениях; кордон и
 *    сейсмостанция у перевала режима не получают — парк о них молчит;
 *  - строка «Разрешение» на карточке места говорит «не требуется», когда
 *    режим это записал, а не зовёт в «Зелёную кнопку»;
 *  - справочник парков получает каналы разрешения со страницы парка;
 *  - снимки — только свои и партнёрские (владелец 14.10: «Только используй
 *    наши фотографии или фото партнеров по возможности»): ни одного кадра
 *    Commons, у каждого автор, партнёрские — те же байты, что на его туре;
 *  - статья летописи связана с карточкой, долиной и страницей парка.
 * Экран судится рендером: блок режима, строка разрешения, «Как добраться»,
 * страница парка, статья.
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
import PlaceSafety from '@/components/places/PlaceSafety';
import { CHRONICLE_BY_SLUG, chronicleForPark, chronicleForPlace } from '@/lib/chronicle/articles';
import { composeAccessText } from '@/lib/places/access-text';
import { locationTypeLabel } from '@/lib/places/location-types';
import { descriptionVoice } from '@/lib/places/description-voice';
import { ownPermitOf, permitNotRequired } from '@/lib/places/own-permit';
import { PARK_PERMIT_SOURCE } from '@/lib/safety/park-permit';
import { TOURISM_DOMAIN } from '@/lib/agents/warmup';
import type { ParkPageData } from '@/lib/parks/park-page';
import type { PlaceSafety as SafetyData } from '@/components/places/types';

afterEach(cleanup);

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1248_nalychevo_natural_park.sql'), 'utf-8');
const PARK = 'ce59fcc5-0e85-487c-9acf-5cbbb46d2e1e';
const VALLEY = '4732f58e-63e5-4ec1-902e-f0f531391193';
const SPRINGS = 'c7c9f572-5e78-4d4f-a9ee-d0182eb313d6';
const PASS = '3dd2ceaf-1351-4625-9171-711eb8b1a455';
const CAMEL = '32aa0d20-10d9-4fbb-a1f7-b90f327b7687';
const KORDON = 'c5b351d0-7989-ea6b-5d79-baedd9a1a996';
const SEISMO = '1d50cbce-c87f-4733-82a2-779ad1ce5718';

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

const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const parkUpdates = updatesOf(PARK);
const parkText = parkUpdates.find((s) => /\n\s*description\s*=/.test(s))!;
const DESCRIPTION = literalOf(parkText, 'description');
const ESSENCE = literalOf(parkText, 'essence');
const ACCESS = literalOf(parkUpdates.find((s) => /access_info\s*=/.test(s))!, 'access_info');
const valleyText = updatesOf(VALLEY).find((s) => /\n\s*description\s*=/.test(s))!;
const springsText = updatesOf(SPRINGS).find((s) => /\n\s*description\s*=/.test(s))!;

const regimeStmts = STATEMENTS.filter((s) => /UPDATE places p/.test(s));
const permitStmt = regimeStmts.find((s) => /eco_permit_required = TRUE/.test(s))!;
const freeStmt = regimeStmts.find((s) => /eco_permit_required = FALSE/.test(s))!;
const RULES = literalOf(permitStmt, 'eco_rules');
const FREE_RULES = literalOf(freeStmt, 'eco_rules');
const idsOf = (stmt: string) => [...stmt.matchAll(/\('([0-9a-f-]{36})', '((?:[^']|'')*)'\)/g)].map((m) => ({ id: m[1], name: m[2] }));
const MEMBERS = idsOf(permitStmt);
const FREE = idsOf(freeStmt);
const parkStmt = STATEMENTS.find((s) => /UPDATE parks/.test(s))!;

describe('карточка парка', () => {
  it('впечатление уходит в архив, на его месте справка; только пока текст прежний', () => {
    expect(parkText).toMatch(/AND description LIKE 'Налычево — не столько парк, сколько огромная чаша среди вулканов%'/);
    expect(parkText).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
    expect(DESCRIPTION).toContain('287 155 гектаров');
    expect(DESCRIPTION).toContain('от 18 августа 1995 года № 194');
    expect(DESCRIPTION).toContain('остров Крашенинникова');
    expect(DESCRIPTION).toMatch(/без разрешения можно бывать только на территории Авачинского перевала/);
    expect(DESCRIPTION).not.toMatch(/дышит|выбор за тобой|два дня|вертол[её]т садится/);
    for (const t of [DESCRIPTION, ESSENCE, ACCESS, RULES, FREE_RULES]) expect(descriptionVoice(t).voice).toBe('plain');
  });

  it('где источники расходятся, карточка числа не называет', () => {
    // Млекопитающих: справочник 2013 года — 33, сайт парка — 31 наземный;
    // кордонов: семь и четыре; Аагские нарзаны: «холодные» и «до 39 °С».
    expect(DESCRIPTION).not.toMatch(/\b3[13] вид|семь (природоохранных )?кордон|холодные Аагские/);
  });

  it('тип — «Природный парк» поверх «Другого»; точка — центр контура OSM поверх заглушки', () => {
    const type = parkUpdates.find((s) => /location_type\s*=/.test(s))!;
    expect(type).toMatch(/SET location_type = 'park'/);
    expect(type).toMatch(/AND location_type = 'other'/);
    expect(locationTypeLabel('park')).toBe('Природный парк');
    const coord = parkUpdates.find((s) => /SET lat\s*=/.test(s))!;
    expect(coord).toMatch(/SET lat = 53\.4571927, lng = 158\.8887989/);
    expect(coord).toMatch(/coord_source = 'external'/);
    expect(coord).toMatch(/AND lat = 53\.5 AND lng = 159\.0/);
  });

  it('отзыв Кузьмича о парке: пустая строка только вместо NULL', () => {
    const s = parkUpdates.find((x) => /SET kuzmich_review/.test(x))!;
    expect(s).toMatch(/kuzmich_review = ''/);
    expect(s).toMatch(/AND kuzmich_review IS NULL/);
  });

  it('«Как добраться»: записанное слово в слово и разрешение природного парка', () => {
    const lines = composeAccessText({
      name: 'Природный парк Налычево', lat: 53.4571927, lng: 158.8887989, district: null, zone: 'avachinsky',
      accessInfo: ACCESS, routes: [], registrationRequired: false,
      eco: { zone: 'natural_park', permitRequired: true }, toursCount: 0,
    });
    expect(lines).toContain(ACCESS);
    expect(lines).toContain('Посещение — по разрешению дирекции природного парка.');
    expect(ACCESS).toMatch(/до горы Кабан в 1,5 км/);
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

describe('долина и источники — справкой', () => {
  it('долина: справка ложится в пустое описание, снятый дневник остаётся в архиве', () => {
    expect(valleyText).toMatch(/AND description IS NULL/);
    expect(valleyText).toMatch(/AND description_withdrawn LIKE 'Пар от ключей стелется%'/);
    expect(valleyText).not.toMatch(/description_withdrawn\s*=/);
    const text = literalOf(valleyText, 'description');
    expect(text).toMatch(/Авачинско-Корякской и Жупановско-Дзензурской групп/);
    expect(text).toMatch(/палаточный лагерь — у реки Жёлтой/);
    expect(descriptionVoice(text).voice).toBe('plain');
  });

  it('источники: впечатление в архив, справка — только поверх прежнего текста', () => {
    expect(springsText).toMatch(/AND description LIKE 'Пар над Налычевской долиной висит слоями%'/);
    expect(springsText).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
    const text = literalOf(springsText, 'description');
    expect(text).toMatch(/самые крупные на\s+Камчатке термальные углекислые источники/);
    expect(text).toMatch(/Первой, Второй и Третьей «лужах»/);
    expect(text).not.toMatch(/зубы сводит|два дня|шипят/);
    expect(descriptionVoice(text).voice).toBe('plain');
  });

  it('заметки Кузьмича о долине и источниках миграция не трогает — их судит перепроверка агента', () => {
    for (const id of [VALLEY, SPRINGS]) {
      expect(updatesOf(id).some((s) => /kuzmich_review/.test(s)), id).toBe(false);
    }
  });
});

describe('режим мест внутри контура', () => {
  it('двадцать мест с разрешением, три на перевале без; кордон и сейсмостанция не трогаются', () => {
    expect(MEMBERS).toHaveLength(20);
    expect(FREE).toHaveLength(3);
    const all = [...MEMBERS, ...FREE].map((m) => m.id);
    expect(new Set(all).size).toBe(23);
    expect(MEMBERS.map((m) => m.id)).toEqual(expect.arrayContaining([PARK, VALLEY, SPRINGS]));
    expect(FREE.map((m) => m.id)).toEqual(expect.arrayContaining([PASS, CAMEL]));
    for (const id of [KORDON, SEISMO]) expect(all).not.toContain(id);
    expect(MEMBERS.map((m) => m.name)).toEqual(expect.arrayContaining(['Вулкан Авачинский', 'Корякская сопка', 'Козельский']));
  });

  it('режим ложится только поверх природного парка, ЮНЕСКО, «нет» или пустоты', () => {
    for (const s of [permitStmt, freeStmt]) {
      expect(s).toMatch(/eco_zone = 'natural_park'/);
      expect(s).toMatch(/AND \(p\.eco_zone IS NULL OR p\.eco_zone IN \('none', 'natural_park', 'UNESCO'\)\)/);
      expect(s).not.toMatch(/'federal_reserve'|'nature_monument'|'national_park'|'zakaznik'/);
    }
    expect(literalOf(permitStmt, 'eco_permit_url')).toBe(PARK_PERMIT_SOURCE.url);
    expect(freeStmt).toMatch(/eco_permit_url = NULL/);
  });

  it('блок режима: правила со страницы парка по одному, пропуск и ссылка на страницу о разрешениях', () => {
    render(<PlaceEco eco={{ zone: 'natural_park', permitRequired: true, rules: RULES, permitUrl: PARK_PERMIT_SOURCE.url }} placeName="Таловские горячие источники" />);
    expect(screen.getByText('Природный парк')).toBeTruthy();
    expect(screen.getByText('Нужен пропуск')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    expect(items[0]).toMatch(/^Посещение — по разрешению КГБУ/);
    expect(items[0]).toMatch(/без разрешения — только территория Авачинского перевала/);
    expect(items[1]).toMatch(/вертол[её]та нужно разрешение дирекции парка/);
    expect(items[4]).toMatch(/^У термальных источников нельзя мыть посуду/);
    expect(screen.getByRole('link', { name: 'Как получить разрешение' }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
  });

  it('перевал: тот же парк, но без пропуска и без ссылки на оформление', () => {
    render(<PlaceEco eco={{ zone: 'natural_park', permitRequired: false, rules: FREE_RULES, permitUrl: null }} placeName="Авачинский перевал" />);
    expect(screen.getByText('Природный парк')).toBeTruthy();
    expect(screen.queryByText('Нужен пропуск')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Как получить разрешение' })).toBeNull();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items[0]).toMatch(/^Территория Авачинского перевала — зона свободного посещения/);
    expect(items[0]).toMatch(/разрешение на посещение не требуется/);
  });

  it('Кузьмич знает про пропуск в «Налычево» и зону свободного посещения', () => {
    const line = TOURISM_DOMAIN.split('\n').find((l) => l.startsWith('- Нужен пропуск'))!;
    expect(line).toMatch(/«Налычево»/);
    expect(line).toMatch(/без разрешения — только территория Авачинского перевала с экструзией Верблюд/);
  });
});

describe('строка «Разрешение» в блоке безопасности', () => {
  const SAFETY: SafetyData = {
    source: 'manual',
    difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
    terrainType: null, roadType: null, roadAccessibility: null, nearestMedicalKm: null,
    emergencyAccess: null, phoneRangerMches: null, satCommunicatorRequired: null,
    rulesRequired: null, weatherThreshold: null, hazardTypes: [],
    capacityPerDay: null, optimalGroupSize: null, openFromDate: null, openToDate: null,
    requiredGear: [], connectivity: null, registrationRequired: true, medicalInfo: null,
  };

  it('режим записал «не нужно» — «не требуется», без «Зелёной кнопки»', () => {
    const eco = { zone: 'natural_park', permitRequired: false, permitUrl: null };
    render(<PlaceSafety safety={SAFETY} placeId="x" ownPermit={ownPermitOf(eco)} permitFree={permitNotRequired(eco)} />);
    expect(screen.getByText('Разрешение на посещение')).toBeTruthy();
    expect(screen.getByText('не требуется')).toBeTruthy();
    expect(screen.queryByText(/Зелёная кнопка/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Android' })).toBeNull();
    // МЧС — другая обязанность, она остаётся.
    expect(screen.getByRole('link', { name: 'МЧС обязательна' })).toBeTruthy();
  });

  it('место парка с разрешением — заявка на страницу парка, как и было', () => {
    const eco = { zone: 'natural_park', permitRequired: true, permitUrl: PARK_PERMIT_SOURCE.url };
    render(<PlaceSafety safety={SAFETY} placeId="x" ownPermit={ownPermitOf(eco)} permitFree={permitNotRequired(eco)} />);
    expect(screen.getByText('Разрешение парка')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'заявка на vulcanikamchatki.ru' }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
    expect(screen.queryByText('не требуется')).toBeNull();
  });

  it('«не записано» — не «не нужно»: пустой режим и «none» оставляют кнопку', () => {
    expect(permitNotRequired(null)).toBe(false);
    expect(permitNotRequired({ zone: null, permitRequired: false })).toBe(false);
    expect(permitNotRequired({ zone: 'none', permitRequired: false })).toBe(false);
    expect(permitNotRequired({ zone: 'natural_park', permitRequired: true })).toBe(false);
    // Вачкажец (1244): памятник природы без разрешения — тоже «не требуется».
    expect(permitNotRequired({ zone: 'nature_monument', permitRequired: false })).toBe(true);
  });

  it('карточка места передаёт признак в блок безопасности', () => {
    const src = readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');
    expect(src).toMatch(/permitFree=\{permitNotRequired\(place\.eco\)\}/);
  });
});

describe('справочник парков', () => {
  const park: ParkPageData = {
    slug: 'nalychevo',
    displayName: 'Природный парк «Налычево»',
    description: literalOf(parkStmt, 'description'),
    zone: 'avachinsky',
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
    expect(parkStmt).toMatch(/WHERE slug = 'nalychevo'/);
    expect(parkStmt).toMatch(/AND description = 'Один из самых посещаемых природных парков Камчатки\. Термальные источники, вулканы Авачинской группы, маршруты любой сложности\.'/);
  });

  it('страница парка: «Получить» — на страницу парка о разрешениях, офис в Елизово, почта, Госуслуги', () => {
    render(<ParkClient park={park} />);
    expect(document.body.textContent).toMatch(/Природный парк · Камчатка/);
    expect(screen.getByRole('link', { name: 'Получить' }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
    expect(document.body.textContent).toMatch(/Офис: город Елизово, улица Завойко, 33/);
    expect(document.body.textContent).toMatch(/пн–сб 9:00–18:00, вс 9:00–16:00, перерыв 13:00–14:00/);
    expect(screen.getByRole('link', { name: 'visit@park-vulcany.ru' }).getAttribute('href')).toBe('mailto:visit@park-vulcany.ru');
    expect(screen.getByRole('link', { name: /Госуслуги 41/ }).getAttribute('href')).toBe('https://gosuslugi41.ru/pgu/volcano_info.htm');
    expect(document.body.textContent).toMatch(/территория Авачинского перевала — зона свободного посещения/);
    expect(descriptionVoice(park.description ?? '').voice).toBe('plain');
  });
});

describe('снимки 1248 — свои и партнёрские', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    items: Array<{ file: string; key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'((?:migrations\/)?photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];
  const heroStmt = STATEMENTS.find((s) => /INSERT INTO ai_route_images/.test(s))!;
  const galleryStmt = STATEMENTS.find((s) => /INSERT INTO place_gallery_photos/.test(s))!;

  it('ни одного кадра Commons: ключи — снимки владельца или партнёра', () => {
    expect(BODY).not.toMatch(/commons\.wikimedia\.org|'wikimedia'\s*,\s*\d/);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, k).toMatch(/^(photos\/nalychevo\/mestechko-[a-z0-9-]+|migrations\/photos\/[0-9a-f]{64})\.jpg$/);
    const authors = new Set([...BODY.matchAll(/'(владелец платформы|Местечко Камчатка|[^']*)',\s*(?:'с разрешения туроператора'|NULL),/g)].map((m) => m[1]));
    for (const a of authors) expect(['владелец платформы', 'Местечко Камчатка']).toContain(a);
  });

  it('снимки владельца — те, что владелец уже ставил своим вулканам (958, 985)', () => {
    const owner = keys.filter((k) => k.startsWith('migrations/photos/'));
    expect(owner).toHaveLength(2);
    const own = ['958_owner_photos_seven_places.sql', '985_koryaksky_evening_gallery.sql']
      .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf-8')).join('\n');
    for (const k of owner) expect(own, k).toContain(`'${k}'`);
  });

  it('снимки партнёра залиты до миграции и это те же байты, что на его турах', () => {
    const partner = keys.filter((k) => k.startsWith('photos/nalychevo/mestechko-'));
    expect(partner).toHaveLength(4);
    const uploaded = new Map(marker.items.map((i) => [i.key, i.file]));
    const tourPhotos = readFileSync(join(ROOT, 'migrations/1217_mestechko_tours.sql'), 'utf-8');
    const origin: Record<string, string> = {
      'photos/nalychevo/mestechko-kupalnya-tretya-luzha.jpg': 'oblet-koryakskiy-avachinskiy-04.jpg',
      'photos/nalychevo/mestechko-krater-avachinskogo.jpg': 'oblet-koryakskiy-avachinskiy-02.jpg',
      'photos/nalychevo/mestechko-avachinskij-i-koryakskaya.jpg': 'oblet-koryakskiy-avachinskiy-03.jpg',
      'photos/nalychevo/mestechko-evrazhka-na-perevale.jpg': 'avachinskiy-pereval-02.jpg',
    };
    for (const k of partner) {
      expect(uploaded.has(k), k).toBe(true);
      const src = origin[k];
      expect(tourPhotos, src).toContain(`/images/mestechko/${src}`);
      const a = readFileSync(join(ROOT, uploaded.get(k)!));
      const b = readFileSync(join(ROOT, 'public/images/mestechko', src));
      expect(a.equals(b), k).toBe(true);
    }
  });

  it('герой — парку, источникам, долине и перевалу; снимок, поставленный человеком, не перетирается', () => {
    for (const id of [PARK, SPRINGS, VALLEY, PASS]) expect(heroStmt, id).toContain(`'${id}'`);
    expect(heroStmt).toMatch(/'manual-upload'/);
    expect(heroStmt).toMatch(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)\s+OR ai_route_images\.prompt = EXCLUDED\.prompt/);
  });

  it('галерея парка встаёт после его снимков, тот же снимок второй раз не ложится', () => {
    expect(galleryStmt).toMatch(/COALESCE\(\(SELECT max\(g\.position\) FROM place_gallery_photos g WHERE g\.ark_id = p\.ark_id\), 0\) \+ s\.ord/);
    expect(galleryStmt).toMatch(/NOT EXISTS \(SELECT 1 FROM place_gallery_photos g\s+WHERE g\.ark_id = p\.ark_id AND g\.s3_key = s\.s3_key\)/);
    expect(galleryStmt).toContain(`'${PARK}'`);
  });
});

describe('статья «Природный парк „Налычево“»', () => {
  const SLUG = 'nalychevo';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const text = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточкой парка, долиной и страницей парка', () => {
    expect(chronicleForPlace(PARK).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPlace(VALLEY).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('nalychevo').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toEqual([
      '/places/prirodnyj-park-nalychevo-2',
      '/park/nalychevo',
      '/letopis/severo-kurilskoe-cunami-1952',
      '/letopis/vulkany-kamchatki',
    ]);
    expect(CHRONICLE_BY_SLUG['severo-kurilskoe-cunami-1952']).toBeTruthy();
    expect(CHRONICLE_BY_SLUG['vulkany-kamchatki']).toBeTruthy();
  });

  it('каждая веха — в тексте, годы по порядку; постановления названы с датами', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(text).toContain('от 18 августа 1995 года № 194');
    expect(text).toContain('от 5 июля 1996 года № 188');
  });

  it('где источники расходятся, статья называет оба числа', () => {
    expect(text).toMatch(/33 вида, сайт парка — 31 вид наземных/);
    expect(text).toMatch(/семь природоохранных кордонов; сайт парка сегодня перечисляет четыре/);
    expect(text).toMatch(/Аагские нарзаны в истоках реки Чистой справочник называет холодными, а сайт парка даёт им до 39 °С/);
  });

  it('главный кадр — снимок владельца, залит в хранилище (кадр партнёра снят до согласия, 15.10)', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ key: string }>;
    };
    expect(article.hero!.key).toBe('photos/nalychevo/vladelec-koryakskaya-sopka-vecherom.jpg');
    expect(marker.items.map((i) => i.key)).toContain(article.hero!.key);
    expect(article.hero!.author).toBe('владелец платформы');
    expect(article.hero!.licenseUrl).toBeUndefined();
    expect(article.hero!.sourceUrl).toBeUndefined();
  });

  it('«Налычево» остался краевым; зона свободного посещения названа', () => {
    expect(text).toMatch(/«Налычево» в него не вошёл/);
    expect(text).not.toMatch(/национальн\S* парк\S* «Налычево»/);
    expect(text).toMatch(/Территория Авачинского перевала — зона свободного посещения/);
  });

  it('страница: заголовок, лента дат, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Природный парк «Налычево»');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/nalychevo/vladelec-koryakskaya-sopka-vecherom.jpg');
    const figure = img.closest('figure')!;
    // Снимок владельца — подпись словами: ни ссылки, ни лицензии, которых у
    // него нет, и ни висящего « · » после имени.
    expect(figure.textContent?.trim()).toBe('Корякская сопка вечером. Фото: владелец платформы');
    // И не пустой <a> без адреса: роли «ссылка» у него нет, а тег — есть.
    expect(figure.querySelectorAll('a')).toHaveLength(0);
    const dates = screen.getByRole('region', { name: 'Главные даты' });
    expect(within(dates).getAllByRole('listitem')).toHaveLength(article.timeline!.length);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
  });
});
