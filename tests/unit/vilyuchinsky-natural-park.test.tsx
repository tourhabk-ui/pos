/**
 * Природный парк «Вилючинский» (14.10, владелец: «Бери по порядку схему»;
 * миграция 1254).
 *
 * Парк создан постановлением Правительства Камчатского края от 28.12.2022
 * № 743-П на месте памятника природы 1990 года. До 14.10 его на платформе не
 * было вовсе: вулкан с режимом «нет», озёра без режима, маршруты в парк — без
 * разрешения. А точка «Озера Зеленое» стояла у дороги на Мутновскую ГеоТЭС —
 * в первой точке линии маршрута к озеру, в 4 км от самого озера (проба 903).
 *
 * Держится то, что делает правку правдой:
 *  - озеро — внутри своей зоны особой охраны по координатам постановления,
 *    а прежняя точка — снаружи (судят числа из постановления, не текст SQL);
 *  - режим — по контуру: четыре места, но не перевал и не Нижне-Вилючинские
 *    источники, хотя их имена и обещают;
 *  - тексты — по постановлению, голос справки; сочинения — в архив;
 *  - маршруты в парк показывают разрешение КГБУ и попадают на страницу парка,
 *    а корень справочника не цепляет город Вилючинск;
 *  - снимки — только партнёра и владельца, у каждого автор.
 * Экран судится рендером: блок режима, дверь разрешения, статья летописи.
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
import ParkPermitAction from '@/components/safety/ParkPermitAction';
import { CHRONICLE_BY_SLUG, chronicleForPark, chronicleForPlace } from '@/lib/chronicle/articles';
import { PARK_PERMIT_SOURCE } from '@/lib/safety/park-permit';
import { locationTypeLabel } from '@/lib/places/location-types';
import { descriptionVoice } from '@/lib/places/description-voice';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { slugify } from '@/lib/text/slugify';
import { migrationBody, migrationStatements, insertValues, setValues, splitTop, valueOf } from '../helpers/migration-sql';

afterEach(cleanup);

const text = () => document.body.textContent ?? '';

const ROOT = process.cwd();
const BODY = migrationBody(readFileSync(join(ROOT, 'migrations/1254_vilyuchinsky_natural_park.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

const CARD = '7626267c-d41f-4c88-8c87-c3313bb8b539';
const VOLCANO = '164f612c-32da-4f0f-b261-c45c09dc2933';
const BARKH = '57918158-2844-435a-a509-c61430a2f5e8';
const TOPOL = '8f31fc1d-103e-4fa2-a720-91adabbd82aa';
const ZELEN = 'ed134429-febe-45d4-9c55-00b12809de24';
const PASS = '8bad8fe6-c7ec-4403-b956-948706649ca8';
const NIZHNE = 'b12debd1-c997-47d1-b791-e6bbad2cdb4c';
/** Внутри контура OSM way 1445902160 (проба 904). */
const MEMBERS = [VOLCANO, BARKH, TOPOL, ZELEN];

const placeInsert = STATEMENTS.find((s) => /INSERT INTO places \(/.test(s))!;
const CARD_ROW = insertValues(placeInsert);
const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const textUpdate = (id: string) => updatesOf(id).find((s) => /(?:\n|\bSET)\s*description\s*=/.test(s))!;
const regime = STATEMENTS.find((s) => /UPDATE places\s/.test(s) && /SET eco_zone = 'natural_park'/.test(s))!;
const RULES = setValues(regime).eco_rules!;
const routes = STATEMENTS.find((s) => /UPDATE kamchatka_routes/.test(s))!;
const parkInsert = STATEMENTS.find((s) => /INSERT INTO parks/.test(s))!;
const PARK_COLS = parkInsert.split(/INSERT INTO parks \(/)[1].split(')')[0].split(',').map((c) => c.trim());
const PARK = Object.fromEntries(
  splitTop(parkInsert.split(/VALUES\s*\(/)[1].replace(/\)\s*ON CONFLICT[\s\S]*$/, '')).map((v, i) => [PARK_COLS[i], valueOf(v)]),
) as Record<string, string | null>;

// ═══ Координаты из постановления № 743-П (приложение к положению) ═════════

/** «52°45'28.9"» → градусы. */
function dms(s: string): number {
  const m = /^(\d+)°(\d+)'([\d.]+)"$/.exec(s.trim());
  if (!m) throw new Error(`не координата: ${s}`);
  return Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
}
const ring = (pairs: string) =>
  pairs.trim().split('\n').map((l) => {
    const [lat, lng] = l.trim().split(/\s+/);
    return [dms(lat), dms(lng)] as [number, number];
  });

/** Зона особой охраны «Озеро Зеленое», точки ЗЛ1–ЗЛ50 (27,87 га). */
const ZELEN_ZONE = ring(`
  52°45'28.9" 158°15'32.8"
  52°45'29.1" 158°15'34.8"
  52°45'29.1" 158°15'35.3"
  52°45'29.8" 158°15'37.0"
  52°45'30.0" 158°15'39.0"
  52°45'29.8" 158°15'41.1"
  52°45'29.1" 158°15'42.8"
  52°45'28.3" 158°15'44.2"
  52°45'28.1" 158°15'46.7"
  52°45'27.9" 158°15'48.2"
  52°45'27.2" 158°15'50.0"
  52°45'26.2" 158°15'51.2"
  52°45'25.0" 158°15'51.6"
  52°45'21.7" 158°15'51.6"
  52°45'19.1" 158°15'52.8"
  52°45'19.1" 158°15'52.8"
  52°45'19.0" 158°15'52.8"
  52°45'16.4" 158°15'53.7"
  52°45'16.3" 158°15'53.8"
  52°45'16.3" 158°15'53.8"
  52°45'13.7" 158°15'54.5"
  52°45'13.2" 158°15'54.5"
  52°45'11.5" 158°15'54.6"
  52°45'11.9" 158°15'52.3"
  52°45'7.4" 158°15'39.9"
  52°45'7.9" 158°15'39.3"
  52°45'8.8" 158°15'38.4"
  52°45'8.8" 158°15'36.6"
  52°45'8.0" 158°15'35.7"
  52°45'8.8" 158°15'34.8"
  52°45'9.8" 158°15'33.2"
  52°45'12.4" 158°15'28.2"
  52°45'12.5" 158°15'28.1"
  52°45'12.6" 158°15'28.0"
  52°45'13.6" 158°15'26.8"
  52°45'13.9" 158°15'26.6"
  52°45'16.1" 158°15'25.5"
  52°45'17.0" 158°15'25.3"
  52°45'19.4" 158°15'25.2"
  52°45'20.1" 158°15'25.3"
  52°45'21.3" 158°15'25.7"
  52°45'21.9" 158°15'26.0"
  52°45'23.0" 158°15'27.1"
  52°45'23.7" 158°15'28.9"
  52°45'23.9" 158°15'30.1"
  52°45'23.9" 158°15'30.1"
  52°45'25.2" 158°15'29.7"
  52°45'25.8" 158°15'29.5"
  52°45'27.1" 158°15'29.9"
  52°45'28.1" 158°15'31.1"
`);

/** Зона особой охраны «Озеро Тополовое», точки 58–61, Т5–Т38 (16,8 га). */
const TOPOL_ZONE = ring(`
  52°48'36.4" 158°16'53.1"
  52°48'32.8" 158°16'55.8"
  52°48'30.3" 158°17'1.4"
  52°48'26.6" 158°17'5.0"
  52°48'23.2" 158°17'10.0"
  52°48'20.6" 158°17'9.0"
  52°48'18.4" 158°17'5.1"
  52°48'17.5" 158°17'2.7"
  52°48'15.3" 158°16'59.8"
  52°48'14.1" 158°16'56.2"
  52°48'12.9" 158°16'54.5"
  52°48'10.9" 158°16'54.2"
  52°48'9.9" 158°16'51.9"
  52°48'9.3" 158°16'48.9"
  52°48'8.6" 158°16'48.4"
  52°48'6.4" 158°16'45.1"
  52°48'6.6" 158°16'42.0"
  52°48'7.1" 158°16'38.9"
  52°48'7.8" 158°16'40.7"
  52°48'9.5" 158°16'41.1"
  52°48'10.7" 158°16'43.0"
  52°48'11.4" 158°16'45.1"
  52°48'11.4" 158°16'47.1"
  52°48'11.4" 158°16'49.6"
  52°48'14.2" 158°16'51.7"
  52°48'15.1" 158°16'53.1"
  52°48'16.8" 158°16'53.0"
  52°48'18.9" 158°16'51.6"
  52°48'20.5" 158°16'51.6"
  52°48'22.3" 158°16'52.2"
  52°48'22.7" 158°16'53.5"
  52°48'23.8" 158°16'53.5"
  52°48'25.2" 158°16'52.6"
  52°48'25.8" 158°16'50.6"
  52°48'26.8" 158°16'48.8"
  52°48'28.0" 158°16'49.1"
  52°48'30.8" 158°16'51.5"
  52°48'32.2" 158°16'52.1"
`);

function inside([lat, lng]: [number, number], poly: Array<[number, number]>): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) hit = !hit;
  }
  return hit;
}

/** Площадь контура, га — плоская проекция, для зоны в сотни метров достаточно. */
function areaHa(poly: Array<[number, number]>): number {
  const lat0 = poly.reduce((s, [y]) => s + y, 0) / poly.length;
  const ky = 111_320;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][1] * kx * poly[i][0] * ky - poly[i][1] * kx * poly[j][0] * ky;
  }
  return Math.abs(a) / 2 / 10_000;
}

function km([lat1, lng1]: [number, number], [lat2, lng2]: [number, number]): number {
  const ky = 111.32;
  const kx = 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lat1 - lat2) * ky, (lng1 - lng2) * kx);
}

describe('координаты постановления — данные для проверки, а не догадка', () => {
  it('площади разобранных контуров сходятся с площадями зон в постановлении', () => {
    expect(areaHa(ZELEN_ZONE)).toBeCloseTo(27.87, 0);
    expect(areaHa(TOPOL_ZONE)).toBeCloseTo(16.8, 0);
  });
});

describe('озеро Зеленое — на озере, а не у дороги', () => {
  const move = updatesOf(ZELEN).find((s) => /SET lat = /.test(s))!;
  const m = /SET lat = ([\d.]+), lng = ([\d.]+)/.exec(move)!;
  const NEW: [number, number] = [Number(m[1]), Number(m[2])];
  const OLD: [number, number] = [52.7347586, 158.2092619];

  it('новая точка — внутри зоны особой охраны «Озеро Зеленое», прежняя — в 4 км снаружи', () => {
    expect(inside(NEW, ZELEN_ZONE)).toBe(true);
    expect(inside(OLD, ZELEN_ZONE)).toBe(false);
    expect(km(OLD, NEW)).toBeGreaterThan(4);
  });

  it('перенос — только пока точка прежняя; происхождение — внешний справочник', () => {
    expect(move).toMatch(/AND abs\(lat - 52\.7347586\) < 0\.000001 AND abs\(lng - 158\.2092619\) < 0\.000001/);
    expect(move).toMatch(/coord_source = 'external'/);
  });

  it('сочинение о месте у дороги — в архив, только пока оно прежнее; справка — по постановлению', () => {
    const s = textUpdate(ZELEN);
    const v = setValues(s);
    expect(s).toMatch(/LIKE 'В кратере потухшего грязевого вулкана, среди серых осыпей Мутновского нагорья%'/);
    expect(s).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
    expect(v.description_withdrawn_reason).toMatch(/миграция 1254$/);
    expect(v.description).toMatch(/27,87 гектара/);
    expect(v.description).toMatch(/арктических гольцов/);
    expect(v.description).not.toMatch(/грязев|тёпл|Мутновского нагорья/);
    const kz = updatesOf(ZELEN).find((x) => /SET kuzmich_review = ''/.test(x))!;
    expect(kz).toMatch(/AND kuzmich_review IS NULL/);
  });
});

describe('озеро Тополовое — точка верна, текст нет', () => {
  it('точка карточки — внутри зоны особой охраны «Озеро Тополовое»; миграция её не двигает', () => {
    expect(inside([52.8055964, 158.2814561], TOPOL_ZONE)).toBe(true);
    expect(updatesOf(TOPOL).some((s) => /SET lat = /.test(s))).toBe(false);
  });

  it('сочинение модели — в архив, справка — по постановлению; заметка Кузьмича — пустая', () => {
    const s = textUpdate(TOPOL);
    const v = setValues(s);
    expect(s).toMatch(/LIKE 'Озеро Тополовое — скрытый уголок камчатской природы%'/);
    expect(v.description).toMatch(/16,8 гектара/);
    expect(v.description).not.toMatch(/тополя Максимовича|53°N|шелест/);
    const kz = updatesOf(TOPOL).find((x) => /SET kuzmich_review = ''/.test(x))!;
    expect(kz).toMatch(/kuzmich_review LIKE 'Тополовое — тихий уголок с тёмной прозрачной водой%'/);
  });
});

describe('Природный парк «Вилючинский» — новая карточка', () => {
  it('новый id, тип «Природный парк», точка — центр контура OSM', () => {
    expect(CARD_ROW.id).toBe(CARD);
    expect(CARD_ROW.name).toBe('Природный парк «Вилючинский»');
    expect(locationTypeLabel(CARD_ROW.location_type!)).toBe('Природный парк');
    expect([CARD_ROW.lat, CARD_ROW.lng]).toEqual(['52.7499980', '158.2645080']);
    expect(CARD_ROW.zone).toBe('avachinsky');
    expect(CARD_ROW.coord_source).toBe('external');
  });

  it('заводится, только если живой карточки с этим именем нет', () => {
    expect(placeInsert).toMatch(/WHERE NOT EXISTS \([\s\S]*q\.merged_into_id IS NULL[\s\S]*'природный парк «вилючинский»'/);
    expect(placeInsert).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('режим: природный парк, разрешение КГБУ; заметка Кузьмича — пустая строка', () => {
    expect(CARD_ROW.eco_zone).toBe('natural_park');
    expect(CARD_ROW.eco_permit_required).toBe('TRUE');
    expect(CARD_ROW.eco_permit_url).toBe(PARK_PERMIT_SOURCE.url);
    expect(CARD_ROW.eco_rules).toBe(RULES);
    expect(CARD_ROW.kuzmich_review).toBe('');
  });

  it('числа — из постановления: год, площадь, прирост лесного фонда', () => {
    expect(CARD_ROW.description).toMatch(/28 декабря 2022 года № 743-П/);
    expect(CARD_ROW.description).toMatch(/15 060,72 гектара/);
    expect(CARD_ROW.description).toMatch(/1417,39 гектара лесного фонда/);
    expect(CARD_ROW.description).toMatch(/11 марта 1990 года/);
  });

  it('профиля безопасности не заводит: опасностей мест постановление не называет', () => {
    expect(BODY).not.toMatch(/location_safety_profile/);
  });

  it('адрес статьи летописи совпадает с адресом, который даёт миграция', () => {
    expect(BODY).toMatch(/SET slug = translit_ru_slug\(p\.name\)\s+WHERE p\.id::text = '7626267c/);
    expect(slugify(CARD_ROW.name!)).toBe('prirodnyj-park-vilyuchinskij');
  });
});

describe('режим парка — по контуру, не по имени', () => {
  it('ровно четыре места внутри контура; перевал и Нижне-Вилючинские — снаружи', () => {
    const ids = [...regime.split(/\bWHERE\b/)[1].matchAll(/'([0-9a-f-]{36})'/g)].map((x) => x[1]);
    expect(ids.sort()).toEqual([...MEMBERS].sort());
    expect(BODY).not.toContain(PASS);
    expect(BODY).not.toContain(NIZHNE);
  });

  it('только поверх пустоты или «нет режима»', () => {
    expect(regime).toMatch(/AND \(eco_zone IS NULL OR eco_zone = 'none'\)/);
  });

  it('блок режима: «Природный парк», шесть правил по положению, ссылка на разрешение', () => {
    render(<PlaceEco eco={{ zone: 'natural_park', permitRequired: true, rules: RULES, permitUrl: PARK_PERMIT_SOURCE.url }} placeName="Озеро Зеленое" />);
    expect(screen.getByText('Природный парк')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    expect(items[0]).toBe('Природный парк регионального значения «Вилючинский» — с 2022 года (постановление Правительства Камчатского края № 743-П), в ведении КГБУ «Природный парк „Вулканы Камчатки“»');
    expect(items[1]).toMatch(/«Зелёная кнопка».*Госуслуги41.*visit@park-vulcany\.ru.*Завойко, 33/);
    // Часть 22: снегоходам разрешена только стоянка вне площадок, не езда.
    expect(items[2]).toMatch(/^Пешком, верхом и на технике — только по дорогам общего пользования и установленным маршрутам/);
    expect(items[2]).toMatch(/снегоходы при постоянном снежном покрове могут стоять и вне их/);
    expect(items[4]).toMatch(/^Озёра Тополовое и Зеленое — зоны особой охраны: пролёт вертолётов ниже 500 метров запрещён/);
    expect(items[5]).toMatch(/экстренный номер — 112$/);
    expect(screen.getByRole('link', { name: 'Как получить разрешение' }).getAttribute('href')).toBe(PARK_PERMIT_SOURCE.url);
  });
});

describe('тексты — по источникам, голос справки', () => {
  const zelen = setValues(textUpdate(ZELEN));
  const topol = setValues(textUpdate(TOPOL));
  const essenceOf = (id: string) => setValues(updatesOf(id).find((s) => /SET essence = /.test(s))!).essence;

  it('голос справки у описаний, сути, «как добраться» и справочника', () => {
    const texts = [
      CARD_ROW.description, CARD_ROW.essence, CARD_ROW.access_info,
      zelen.description, zelen.access_info, topol.description, topol.access_info,
      essenceOf(BARKH), essenceOf(VOLCANO),
      PARK.description,
    ];
    for (const t of texts) {
      expect(t).toBeTruthy();
      expect(descriptionVoice(t).voice, t!.slice(0, 60)).toBe('plain');
    }
    // Суть озёр — COALESCE: написанная кем-то раньше не затирается.
    expect(textUpdate(ZELEN)).toMatch(/essence = COALESCE\(essence,/);
  });

  it('Бархатная: справка ГВП остаётся, суть только поверх пустоты, выдуманная заметка — пустая строка', () => {
    expect(updatesOf(BARKH).some((s) => /description\s*=/.test(s))).toBe(false);
    expect(updatesOf(BARKH).find((s) => /SET essence = /.test(s))).toMatch(/AND essence IS NULL/);
    expect(essenceOf(BARKH)).toMatch(/870 метров/);
    const kz = updatesOf(BARKH).find((s) => /SET kuzmich_review = ''/.test(s))!;
    expect(kz).toMatch(/kuzmich_review LIKE 'Бархатная сопка — добрый вулкан для первого знакомства%'/);
  });
});

describe('маршруты парка', () => {
  const rows = [...routes.matchAll(/\('([0-9a-f-]{36})', '([^']+)'\)/g)].map((x) => ({ id: x[1], title: x[2] }));

  it('семь маршрутов с целью внутри контура; название сверяется; только поверх пустоты или имени сети', () => {
    expect(rows.map((r) => r.title).sort()).toEqual([
      'Вилючинский водопад', 'Восхождение на Вилючинский вулкан', 'Вулкан Бархатная сопка',
      'Вулкан Вилючинский', 'К озеру Тополовому', 'Озеро Зеленое', 'Озеро Тополовое',
    ]);
    expect(routes).toMatch(/SET park_name = 'Природный парк «Вилючинский»'/);
    expect(routes).toMatch(/\(kr\.id::text = v\.route_id OR kr\.ark_id::text = v\.route_id\)\s+AND kr\.title = v\.title/);
    expect(routes).toMatch(/AND \(kr\.park_name IS NULL OR kr\.park_name ILIKE 'Природный парк%Вулканы Камчатки%'\)/);
  });

  it('карточка маршрута парка — разрешение КГБУ; ни заявки в заповедник, ни оговорки нацпарка', () => {
    render(<ParkPermitAction title="Восхождение на Вилючинский вулкан" parkName="Природный парк «Вилючинский»" />);
    expect(screen.getByRole('link', { name: /Android/ })).toBeTruthy();
    expect(text()).toMatch(/Природный парк «Вилючинский»/);
    expect(screen.queryByRole('link', { name: /Страница заявок/ })).toBeNull();
    expect(text()).not.toMatch(/часть национального парка/);
  });

  it('корень справочника находит маршруты парка, но не город Вилючинск и не источники за границей', () => {
    const term = PARK.search_term!.toLowerCase();
    const inPark = (parkName: string) => parkName.toLowerCase().includes(term);
    expect(inPark('Природный парк «Вилючинский»')).toBe(true);
    expect(inPark('Вилючинск')).toBe(false);
    expect(inPark('Нижне-Вилючинские')).toBe(false);
  });
});

describe('справочник парков: страница парка', () => {
  it('«Природный парк» над заголовком, разрешение и каналы КГБУ, включена', () => {
    expect(PARK.slug).toBe('vilyuchinsky');
    expect(parkKindLabel(PARK.display_name!)).toBe('Природный парк');
    expect(PARK.permit_url).toBe(PARK_PERMIT_SOURCE.url);
    expect(PARK.permit_email).toBe('visit@park-vulcany.ru');
    expect(PARK.permit_gosuslugi_url).toBe('https://gosuslugi41.ru/pgu/volcano_info.htm');
    expect(PARK.is_active).toBe('TRUE');
    expect(parkInsert).toMatch(/ON CONFLICT \(slug\) DO NOTHING/);
  });
});

describe('снимки 1254 — партнёра и владельца', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    run: number;
    items: Array<{ file: string; key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'((?:migrations\/)?photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((x) => x[1]))];
  /** Ключ хранилища → кадр облёта «Местечка Камчатка» (миграция 1217). */
  const ORIGIN: Record<string, string> = {
    'photos/vilyuchinsky/mestechko-vilyuchinskij-osenyu.jpg': 'mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-02.jpg',
    'photos/vilyuchinsky/mestechko-vilyuchinskij-v-snegu.jpg': 'mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-05.jpg',
  };

  it('ни одного кадра Commons: ключи — снимки владельца или партнёра', () => {
    expect(BODY).not.toMatch(/commons\.wikimedia\.org|'wikimedia'\s*,\s*\d/);
    for (const k of keys) expect(k, k).toMatch(/^(photos\/vilyuchinsky\/mestechko-[a-z0-9-]+|migrations\/photos\/[0-9a-f]{64})\.jpg$/);
  });

  it('у каждого кадра галереи — автор; у партнёрского — разрешение и страница партнёра', () => {
    const shots = STATEMENTS.find((s) => /INSERT INTO place_gallery_photos/.test(s))!;
    const rows = [...shots.matchAll(/\(\s*'([0-9a-f-]{36})',\s*\d+,\s*\d+,\s*\d+,\s*'[^']*',\s*'([^']*)',\s*('[^']*'|NULL),\s*('[^']*'|NULL),\s*'([^']+\.jpg)'\)/g)];
    expect(rows).toHaveLength(6);
    for (const [, place, author, license, source, key] of rows) {
      expect([CARD, VOLCANO]).toContain(place);
      expect(author, key).toMatch(/^(Местечко Камчатка|владелец платформы)$/);
      if (author === 'владелец платформы') {
        expect(key).toMatch(/^migrations\/photos\//);
      } else {
        expect(license).toBe("'с разрешения туроператора'");
        expect(source).toBe("'https://vedarai.ru/operators/mestechko'");
      }
    }
    expect(shots).toMatch(/COALESCE\(\(SELECT max\(g\.position\)/);
    const hero = STATEMENTS.find((s) => /INSERT INTO ai_route_images/.test(s))!;
    expect(hero).toMatch(/'Местечко Камчатка', 'с разрешения туроператора', NULL::text, 'https:\/\/vedarai\.ru\/operators\/mestechko'/);
    expect(hero).toMatch(/WHERE p\.id::text = '7626267c/);
  });

  it('снимки владельца — те, что он прислал о Вилючинском (979, 1039)', () => {
    const owner = keys.filter((k) => k.startsWith('migrations/photos/'));
    expect(owner).toHaveLength(2);
    const own = ['979_vilyuchinsky_owner_photos.sql', '1039_vilyuchinsky_mikizha_better_frame.sql']
      .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf-8')).join('\n');
    for (const k of owner) expect(own, k).toContain(k);
  });

  it('партнёрские залиты прогоном 11, и это те же байты, что на облёте «Местечка»', () => {
    expect(marker.run).toBeGreaterThanOrEqual(11);
    const partner = keys.filter((k) => k.startsWith('photos/'));
    expect(partner.sort()).toEqual(Object.keys(ORIGIN).sort());
    const uploaded = new Map(marker.items.map((i) => [i.key, i.file]));
    const tours = readFileSync(join(ROOT, 'migrations/1217_mestechko_tours.sql'), 'utf-8');
    for (const k of partner) {
      const file = uploaded.get(k);
      expect(file, k).toBeTruthy();
      expect(readFileSync(join(ROOT, file!)).equals(readFileSync(join(ROOT, 'public/images', ORIGIN[k]))), k).toBe(true);
      expect(tours, ORIGIN[k]).toContain(ORIGIN[k].split('/')[1]);
    }
  });

  it('кадры Мутновского и Горелого с того же облёта не взяты', () => {
    const notHere = ['01', '03', '04'].map((n) => readFileSync(join(ROOT, `public/images/mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-${n}.jpg`)));
    for (const k of Object.keys(ORIGIN)) {
      const copy = readFileSync(join(ROOT, marker.items.find((i) => i.key === k)!.file));
      for (const m of notHere) expect(copy.equals(m), k).toBe(false);
    }
  });
});

describe('статья «Природный парк «Вилючинский»»', () => {
  const SLUG = 'vilyuchinskij-park';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const all = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточками парка, вулкана и озёр и со страницей парка', () => {
    for (const id of [CARD, VOLCANO, TOPOL, ZELEN]) expect(chronicleForPlace(id).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('vilyuchinsky').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toContain(`/places/${slugify(CARD_ROW.name!)}`);
  });

  it('каждая веха — в тексте, годы по порядку; числа — из постановления', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(all).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(all).toMatch(/15 060,72 гектара/);
    expect(all).toMatch(/№ 743-П/);
  });

  it('страница: главный кадр партнёра с подписью, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Природный парк «Вилючинский»');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/vilyuchinsky/mestechko-vilyuchinskij-osenyu.jpg');
    const figure = img.closest('figure')!;
    expect(within(figure).getByRole('link', { name: 'Местечко Камчатка' }).getAttribute('href')).toBe('https://vedarai.ru/operators/mestechko');
    expect(figure.textContent).toMatch(/Местечко Камчатка · с разрешения туроператора/);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      (article.links ?? []).map((l) => l.href),
    );
  });
});
