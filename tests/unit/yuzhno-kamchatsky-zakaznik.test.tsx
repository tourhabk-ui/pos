/**
 * Южно-Камчатский федеральный заказник имени Т. И. Шпиленка (14.10, владелец:
 * «Бери по порядку схему»; миграция 1252).
 *
 * Заказник — третья территория, которой управляет ФГБУ «Кроноцкий
 * государственный заповедник», рядом с Кроноцким и Корякским заповедниками.
 * Порядок посещения у всех трёх один и свой: заявка с kronoki.ru на почту
 * заповедника (проба 882). До 14.10 карточка маршрута у Курильского озера
 * звала оформлять разрешение «Зелёной кнопкой» — приложением сети КРАЕВЫХ
 * природных парков, к заказнику отношения не имеющим.
 *
 * Держится то, что делает правку правдой:
 *  - дверь к разрешению — заявка в заповедник, а не приложение краевых парков;
 *  - тип места «Заказник» во всех словарях, территория — не стихия;
 *  - заказник — по контуру OSM 5615010, а не по имени: одиннадцать мест,
 *    и не «Орлиное крыло» у самой границы;
 *  - тексты — по сайту заповедника и Википедии, голос справки; впечатления,
 *    догадки и выдумки — в архив, а не переписаны «покрасивее»;
 *  - снимки — только партнёров и владельца, у каждого автор;
 *  - страница заказника в справочнике берёт свои маршруты, не парка-тёзки.
 * Экран судится рендером: дверь разрешения, блок режима, статья летописи.
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
import { kronokiTerritory, federalizedPark, KRONOKI_REQUESTS } from '@/lib/safety/park-permit';
import { LOCATION_TYPES, locationTypeLabel } from '@/lib/places/location-types';
import { EXCLUDED_TYPES } from '@/lib/stats/element-groups';
import { placeMatchesFilter } from '@/lib/map/place-filter';
import { placeMarkerSvg, PLACE_KIND_COLOR, PLACE_MARKER_KINDS } from '@/lib/map/place-marker-icons';
import { descriptionVoice } from '@/lib/places/description-voice';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { slugify } from '@/lib/text/slugify';
import { migrationBody, migrationStatements, insertValues, setValues, splitTop, valueOf } from '../helpers/migration-sql';

afterEach(cleanup);

const text = () => document.body.textContent ?? '';

describe('маршрут на территории Кроноцкого заповедника — заявка в заповедник', () => {
  it('у Курильского озера: страница заявок kronoki.ru и почта заповедника, «Зелёной кнопки» нет', () => {
    render(
      <ParkPermitAction
        title="Тайны Курильского озера"
        parkName="Южно-Камчатский заказник федерального значения"
        parkApprovalUrl="https://www.vulcanikamchatki.ru/whatever/"
      />,
    );
    expect(text()).toMatch(/Посещение — по заявке и разрешению ФГБУ «Кроноцкий государственный заповедник»/);
    expect(text()).toMatch(/разрешение оформляется отдельно/);
    expect(screen.getByRole('link', { name: /Страница заявок/ }).getAttribute('href'))
      .toBe('https://kronoki.ru/ru/visit/requests/');
    expect(screen.getByRole('link', { name: 'tourism@kronoki.ru' }).getAttribute('href'))
      .toBe('mailto:tourism@kronoki.ru');
    // Подпись территории называет заказник, а не парк.
    expect(text()).toMatch(/Южно-Камчатский федеральный заказник/);
    // Ни приложения краевых парков, ни их согласования, ни оговорки нацпарка.
    expect(screen.queryByRole('link', { name: /Android|iPhone/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Согласование маршрута/ })).toBeNull();
    expect(text()).not.toMatch(/Вулканы Камчатки|национальн/i);
    // Две обязанности по-прежнему названы разными.
    expect(text()).toMatch(/Это не то же, что регистрация в МЧС/);
  });

  it('территорию называет и одно поле парка маршрута, когда в названии её нет', () => {
    render(<ParkPermitAction title="Вулкан Кошелева" parkName="Южно-Камчатский заказник федерального значения" />);
    expect(screen.getByRole('link', { name: /Страница заявок/ }).getAttribute('href')).toBe(KRONOKI_REQUESTS.url);
    expect(screen.queryByRole('link', { name: /Android|iPhone/ })).toBeNull();
  });

  it('строкой на карточке — ссылка на заявку, а не магазины приложений', () => {
    render(<ParkPermitAction variant="compact" title="Курильское озеро" />);
    const link = screen.getByRole('link', { name: /Заявка в Кроноцкий заповедник/ });
    expect(link.getAttribute('href')).toBe(KRONOKI_REQUESTS.url);
    expect(screen.queryByRole('link', { name: /Android|iPhone/ })).toBeNull();
  });

  it('Долина гейзеров, кальдера Узон и Корякский заповедник — та же дверь', () => {
    expect(kronokiTerritory(null, 'Долина гейзеров')?.name).toBe('Кроноцкий заповедник');
    expect(kronokiTerritory('Кроноцкий государственный природный биосферный заповедник')?.name).toBe('Кроноцкий заповедник');
    expect(kronokiTerritory(null, 'Кальдера Узон')?.name).toBe('Кроноцкий заповедник');
    expect(kronokiTerritory('Корякский заповедник')?.name).toBe('Корякский заповедник');
    expect(kronokiTerritory(null, 'Заказник имени Т. И. Шпиленка')?.name).toBe('Южно-Камчатский федеральный заказник');
    render(<ParkPermitAction title="Долина гейзеров" />);
    expect(screen.getByRole('link', { name: /Страница заявок/ }).getAttribute('href')).toBe(KRONOKI_REQUESTS.url);
  });

  it('не по соседству: вулкан Кроноцкий, природный парк-тёзка и Налычево — не заповедник', () => {
    // Вулкан стоит в заповеднике, но имя вулкана — не имя территории; угадывать
    // по нему значило бы однажды назвать заповедником чужую землю.
    expect(kronokiTerritory(null, 'Вулкан Кроноцкий')).toBeNull();
    expect(kronokiTerritory('Природный парк Южно-Камчатский')).toBeNull();
    expect(kronokiTerritory('Налычево', 'Долина Налычево')).toBeNull();
    expect(kronokiTerritory(null, null, '')).toBeNull();
    // Парк-тёзка по-прежнему получает оговорку о национальном парке.
    expect(federalizedPark('Южно-Камчатский', 'Вулкан Горелый')?.name).toBe('«Южно-Камчатский»');
    render(<ParkPermitAction title="Вулкан Горелый" parkName="Южно-Камчатский" />);
    expect(text()).toMatch(/часть национального парка «Вулканы Камчатки»/);
    expect(screen.queryByRole('link', { name: /Страница заявок/ })).toBeNull();
  });

  it('у источника — ведомство, страница заявок и дата снятия', () => {
    expect(KRONOKI_REQUESTS.authority).toBe('ФГБУ «Кроноцкий государственный заповедник»');
    expect(KRONOKI_REQUESTS.url).toMatch(/^https:\/\/kronoki\.ru\//);
    expect(KRONOKI_REQUESTS.asOf).not.toHaveLength(0);
  });
});

describe('тип места «Заказник»', () => {
  it('подпись в общем словаре — «Заказник», не «Заповедник» и не «Лес»', () => {
    expect(LOCATION_TYPES.zakaznik).toBe('Заказник');
  });

  it('территория, а не стихия: в счёт стихий не идёт', () => {
    expect(EXCLUDED_TYPES).toContain('zakaznik');
  });

  it('на карте — чип «Леса и парки», щит охраняемой территории и зелёный цвет леса', () => {
    expect(placeMatchesFilter('zakaznik', 'forest')).toBe(true);
    expect(PLACE_MARKER_KINDS).toContain('zakaznik');
    expect(placeMarkerSvg('#15803D', 'zakaznik')).toBe(placeMarkerSvg('#15803D', 'reserve'));
    expect(placeMarkerSvg('#15803D', 'zakaznik')).not.toBe(placeMarkerSvg('#15803D', 'other'));
    expect(PLACE_KIND_COLOR.zakaznik).toBe(PLACE_KIND_COLOR.forest);
  });
});

// ═══ Миграция 1252 ═══════════════════════════════════════════════════════

const ROOT = process.cwd();
const BODY = migrationBody(readFileSync(join(ROOT, 'migrations/1252_yuzhno_kamchatsky_zakaznik.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

const CARD = 'a79c9a19-e5c6-4d99-9134-cae496430dca';
const KURILE = '630819da-48d1-4bb8-99c9-3b190d6ae26c';
const CALDERA = '5d5ab623-3faf-41d7-80c0-536130118432';
const KAMBAL = 'e0b131dc-6dcb-472c-b0a7-90fee55204b6';
const KOSHEL = '2b9c567e-1ffc-403e-a69a-6d72c93b88ae';
const KUTKH = '663e37f3-5deb-4907-ac25-321dd247d85e';
const OZERN = '31448f8a-a720-41a1-8536-854dfc83d816';
const KHAKYT = '18c516d2-cfda-43a0-adda-768a125b366b';
const KAMGOR = '7adea817-0392-4c41-97a8-7693c7141310';
const ORLIN = '0fa4286f-d7e6-4083-814c-9121b3ef3a87';
const VKOSH = '14999081-db57-43d3-8aad-f6c8361b69ac';
const GREM = 'e7cc9f9d-479e-432f-8d1c-adcf6b62a1d8';
const DIKIY = '8f56bd0e-3c13-45ae-bfa5-65df09ba5c1e';
/** Внутри контура OSM 5615010 и дальше допуска упрощения от границы (проба 883). */
const MEMBERS = [KURILE, CALDERA, KAMBAL, KOSHEL, KUTKH, OZERN, KHAKYT, KAMGOR, VKOSH, GREM, DIKIY];

const placeInsert = STATEMENTS.find((s) => /INSERT INTO places \(/.test(s))!;
const CARD_ROW = insertValues(placeInsert);
const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const textUpdate = (id: string) => updatesOf(id).find((s) => /(?:\n|\bSET)\s*description\s*=/.test(s))!;
const regime = STATEMENTS.find((s) => /UPDATE places\s/.test(s) && /SET eco_zone = 'zakaznik'/.test(s))!;
const RULES = setValues(regime).eco_rules!;
const parkInsert = STATEMENTS.find((s) => /INSERT INTO parks/.test(s))!;

/** Начало дневника, которым 1247 его узнала, — из её реестра. */
const M1247 = migrationBody(readFileSync(join(ROOT, 'migrations/1247_place_diary_descriptions_withdrawn.sql'), 'utf-8'));
const headOf1247 = (id: string) => new RegExp(`\\('${id}', '((?:[^']|'')*)'\\)`).exec(M1247)?.[1] ?? null;

describe('Южно-Камчатский заказник — новая карточка', () => {
  it('новый id, тип «Заказник», точка внутри контура OSM 5615010', () => {
    expect(CARD_ROW.id).toBe(CARD);
    expect(CARD_ROW.name).toBe('Южно-Камчатский заказник');
    expect(locationTypeLabel(CARD_ROW.location_type!)).toBe('Заказник');
    expect([CARD_ROW.lat, CARD_ROW.lng]).toEqual(['51.2726400', '156.9794100']);
    expect(CARD_ROW.zone).toBe('southern');
    expect(CARD_ROW.coord_source).toBe('external');
  });

  it('заводится, только если живой карточки с этим именем нет', () => {
    expect(placeInsert).toMatch(/WHERE NOT EXISTS \([\s\S]*q\.merged_into_id IS NULL[\s\S]*'южно-камчатский заказник'/);
    expect(placeInsert).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('режим: заказник, разрешение по заявке в заповедник; заметка Кузьмича — пустая строка', () => {
    expect(CARD_ROW.eco_zone).toBe('zakaznik');
    expect(CARD_ROW.eco_permit_required).toBe('TRUE');
    expect(CARD_ROW.eco_permit_url).toBe('https://kronoki.ru/ru/visit/requests/');
    expect(CARD_ROW.eco_rules).toBe(RULES);
    expect(CARD_ROW.kuzmich_review).toBe('');
  });

  it('адрес статьи летописи совпадает с адресом, который даёт миграция', () => {
    expect(BODY).toMatch(/SET slug = translit_ru_slug\(p\.name\)\s+WHERE p\.id::text = 'a79c9a19/);
    expect(slugify(CARD_ROW.name!)).toBe('yuzhno-kamchatskij-zakaznik');
  });

  it('профиль: медведи; регистрация «не записано»; выдуманных умолчаний нет', () => {
    const profile = STATEMENTS.find((s) => /INSERT INTO location_safety_profile/.test(s))!;
    expect(profile).toMatch(/ARRAY\['bears'\]::text\[\], FALSE, 'manual'/);
    expect(profile).toMatch(/SELECT p\.ark_id, NULL, NULL, NULL,\s+NULL, NULL, NULL, NULL,/);
  });

  it('год присвоения имени не называется: Википедия пишет 2016-й, а Шпиленок умер 23 декабря 2016-го', () => {
    expect(CARD_ROW.description).toMatch(/Заказник носит имя Тихона Шпиленка/);
    for (const t of [CARD_ROW.description!, CARD_ROW.essence!]) expect(t).not.toMatch(/присвоен/);
  });
});

describe('режим заказника — по контуру, не по имени', () => {
  it('ровно одиннадцать мест внутри контура; «Орлиного крыла» у самой границы среди них нет', () => {
    const ids = [...regime.split(/\bWHERE\b/)[1].matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...MEMBERS].sort());
    expect(ids).not.toContain(ORLIN);
  });

  it('только поверх пустоты, «нет режима» или прежнего шаблона', () => {
    expect(regime).toMatch(/AND \(eco_zone IS NULL\s+OR eco_zone = 'none'\s+OR \(eco_zone = 'zakaznik' AND eco_rules LIKE 'Государственный природный заказник — охраняются места нереста лосося%'\)\)/);
  });

  it('блок режима: «Государственный заказник», четыре правила — имя, заявка, правила, служба охраны', () => {
    render(<PlaceEco eco={{ zone: 'zakaznik', permitRequired: true, rules: RULES, permitUrl: KRONOKI_REQUESTS.url }} placeName="Курильское озеро" />);
    expect(screen.getByText('Государственный заказник')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    // Правила делятся по «. » — инициалы «Т. И.» разорвали бы первую строку.
    expect(items).toHaveLength(4);
    expect(items[0]).toBe('Южно-Камчатский государственный природный заказник федерального значения имени Тихона Шпиленка — в ведении ФГБУ «Кроноцкий государственный заповедник»');
    expect(items[1]).toMatch(/^Посещение — по заявке и разрешению Кроноцкого заповедника: .*tourism@kronoki\.ru.*разрешение оформляется отдельно$/);
    expect(items[2]).toMatch(/«Правила пребывания на территории»$/);
    expect(items[3]).toMatch(/службу охраны: \+7 \(924\) 790-61-21 \(kronoki\.ru, октябрь 2026\); экстренный номер — 112$/);
    // Ссылка не обещает «онлайн»: у заповедника это форма заявки на почту.
    const link = screen.getByRole('link', { name: 'Как получить разрешение' });
    expect(link.getAttribute('href')).toBe('https://kronoki.ru/ru/visit/requests/');
    expect(text()).not.toMatch(/онлайн/);
  });

  it('описание режима — по закону об ООПТ, а не про одно Курильское озеро', () => {
    render(<PlaceEco eco={{ zone: 'zakaznik', permitRequired: false, rules: null, permitUrl: null }} placeName="Река Коль" />);
    expect(text()).toMatch(/особо охраняемая природная территория/);
    expect(text()).toMatch(/записано в положении о заказнике/);
    expect(text()).not.toMatch(/зимовки медведей/);
  });
});

describe('тексты — по источникам, голос справки', () => {
  const kurile = setValues(textUpdate(KURILE));
  const kutkh = setValues(textUpdate(KUTKH));
  const kambal = setValues(textUpdate(KAMBAL));
  const khakyt = setValues(textUpdate(KHAKYT));
  const dikiy = setValues(textUpdate(DIKIY));
  /** VALUES строки справочника — в порядке колонок INSERT. */
  const parkValues = splitTop(parkInsert.split(/VALUES\s*\(/)[1].replace(/\)\s*ON CONFLICT[\s\S]*$/, '')).map(valueOf);
  const park = { description: parkValues[2] };

  it('голос справки у описаний, сути, «как добраться» и справочника', () => {
    const texts = [
      CARD_ROW.description, CARD_ROW.essence, CARD_ROW.access_info,
      kurile.description, kurile.essence, kurile.access_info,
      kutkh.description, kutkh.essence, kutkh.access_info,
      kambal.description, kambal.essence,
      khakyt.description, khakyt.essence,
      dikiy.description,
      park.description,
    ];
    for (const t of texts) {
      expect(t).toBeTruthy();
      expect(descriptionVoice(t).voice, t!.slice(0, 60)).toBe('plain');
    }
  });

  it('Курильское озеро: впечатление — в архив, только пока оно прежнее; числа — заповедника', () => {
    const s = textUpdate(KURILE);
    expect(s).toMatch(/AND regexp_replace\(description, '\^\\s\+', ''\) LIKE 'В августе притоки Курильского озера становятся алыми от нерки%'/);
    expect(s).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
    expect(kurile.description_withdrawn_reason).toMatch(/впечатление вместо справки/);
    expect(kurile.description).toMatch(/316 метров/);
    expect(kurile.description).toMatch(/Кроноцкий заповедник датирует её 8300–8400 годами назад/);
    // Высоты озера над морем источники называют разные (104 и 81 м) — текст молчит.
    expect(kurile.description).not.toMatch(/\b(104|81) м/);
    const k = updatesOf(KURILE).find((x) => /kuzmich_review = ''/.test(x))!;
    expect(k).toMatch(/kuzmich_review LIKE 'В августе у Курильского озера вода алая от нерки%'/);
  });

  it('Кутхины Баты и Дикий гребень: дневник узнаётся выражением 1247', () => {
    for (const id of [KUTKH, DIKIY]) {
      const head = headOf1247(id);
      expect(head, id).not.toBeNull();
      expect(textUpdate(id)).toContain(`AND left(regexp_replace(description_withdrawn, '^\\s+', ''), 60) = '${head}'`);
      expect(textUpdate(id)).toMatch(/AND description IS NULL/);
    }
    expect(kutkh.description).toMatch(/«лодки Кутха»/);
    expect(dikiy.description).toMatch(/1080 метров/);
  });

  it('Камбальный: высота заповедника, а не 2156; «подъём без подготовки» снят', () => {
    expect(textUpdate(KAMBAL)).toMatch(/LIKE 'Вулкан Камбальная сопка — действующий стратовулкан, расположенный в южной части%'/);
    expect(kambal.description).toMatch(/2161 метр/);
    expect(kambal.description).not.toMatch(/2156|альпинистской подготовки|связь/);
    expect(kambal.description).toMatch(/25 марта 2017 года/);
  });

  it('Хакыцын впадает в озеро; «— сезон медведей» снято из имени, прежнее — в другие имена', () => {
    expect(khakyt.description).toMatch(/впадающих в Курильское озеро/);
    expect(khakyt.description).not.toMatch(/к морю/);
    const rename = updatesOf(KHAKYT).find((s) => /SET name = /.test(s))!;
    expect(rename).toMatch(/SET name = 'Река Хакыцын'[\s\S]*AND name = 'Река Хакыцын — сезон медведей'/);
    expect(BODY).toMatch(/\('18c516d2-cfda-43a0-adda-768a125b366b', 'Река Хакыцын — сезон медведей',\s+'прежнее имя карточки'\)/);
  });

  it('без источника — только в архив: впечатление, догадка, выдумка; заметки Кузьмича — пустые', () => {
    const heads: Record<string, string> = {
      [OZERN]: 'Горячий пар поднимается прямо из прибрежного песка%',
      [KAMGOR]: '«Каменный городок» — это, скорее всего, участок дикой природы%',
      [ORLIN]: 'Скала Орлиное крыло — скальный выступ характерной формы на побережье%',
    };
    for (const [id, head] of Object.entries(heads)) {
      const s = textUpdate(id);
      const v = setValues(s);
      expect(v.description, id).toBeNull();
      expect(v.description_withdrawn_reason, id).toMatch(/миграция 1252$/);
      expect(s, id).toContain(`LIKE '${head}'`);
    }
    const kz = STATEMENTS.find((s) => /SET kuzmich_review = ''/.test(s) && s.includes(`'${ORLIN}'`))!;
    for (const id of [OZERN, KAMGOR, ORLIN]) expect(kz).toMatch(new RegExp(`id::text = '${id}' AND kuzmich_review LIKE '`));
  });
});

describe('профили безопасности — из шаблона в записанное', () => {
  const p = STATEMENTS.find((s) => /UPDATE location_safety_profile/.test(s))!;
  const rows = Object.fromEntries([...p.matchAll(/\('([0-9a-f-]{36})', ARRAY\[([^\]]*)\]/g)].map((m) => [m[1], m[2]]));

  it('медведи — бассейн озера; термальные зоны и газы — Камбальный и Кошелевский массив', () => {
    expect(rows).toEqual({
      [KURILE]: "'bears'", [CALDERA]: "'bears'", [KHAKYT]: "'bears'",
      [KAMBAL]: "'thermal', 'volcanic_gas'", [KOSHEL]: "'thermal', 'volcanic_gas'",
      [VKOSH]: "'thermal', 'volcanic_gas'", [GREM]: "'thermal', 'volcanic_gas'",
    });
  });

  it('только поверх шаблона; «грунтовая дорога» к озеру без дорог — NULL', () => {
    expect(p).toMatch(/AND lsp\.profile_source = 'type_template'/);
    expect(p).toMatch(/road_type = NULL/);
  });
});

describe('справочник парков: страница заказника', () => {
  it('«Заказник» над заголовком, корень парка-тёзки, заявка и почта заповедника, включена', () => {
    expect(parkInsert).toMatch(/'yuzhno-kamchatsky-zakaznik',\s+'Южно-Камчатский федеральный заказник'/);
    expect(parkKindLabel('Южно-Камчатский федеральный заказник')).toBe('Заказник');
    expect(parkInsert).toMatch(/'https:\/\/kronoki\.ru\/ru\/visit\/requests\/',\s+'tourism@kronoki\.ru',\s+'Южно-Камчатск',\s+TRUE/);
    expect(parkInsert).toMatch(/ON CONFLICT \(slug\) DO NOTHING/);
  });
});

describe('снимки 1252 — партнёров и владельца', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    run: number;
    items: Array<{ file: string; key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'((?:migrations\/)?photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];
  /** Ключ хранилища → кадр на туре партнёра (миграции 1177 и 1217). */
  const ORIGIN: Record<string, string> = {
    'photos/yuzhno-kamchatskij-zakaznik/kraj-vulkanov-tablichka-kurilskoe-ozero.jpg': 'volcanoesland/avtotur-kurilskoe-ozero-04.jpg',
    'photos/yuzhno-kamchatskij-zakaznik/kraj-vulkanov-stoyanka-u-ozera.jpg': 'volcanoesland/avtotur-kurilskoe-ozero-05.jpg',
    'photos/yuzhno-kamchatskij-zakaznik/kraj-vulkanov-kutkhiny-baty.jpg': 'volcanoesland/avtotur-kurilskoe-ozero-02.jpg',
    'photos/yuzhno-kamchatskij-zakaznik/kraj-vulkanov-kutkhiny-baty-vblizi.jpg': 'volcanoesland/avtotur-kurilskoe-ozero-03.jpg',
    'photos/yuzhno-kamchatskij-zakaznik/mestechko-medvedica-s-medvezhonkom.jpg': 'mestechko/kurilskoe-ozero-02.jpg',
  };

  it('ни одного кадра Commons: ключи — снимки владельца или партнёров', () => {
    expect(BODY).not.toMatch(/commons\.wikimedia\.org|'wikimedia'\s*,\s*\d/);
    for (const k of keys) expect(k, k).toMatch(/^(photos\/yuzhno-kamchatskij-zakaznik\/(kraj-vulkanov|mestechko)-[a-z0-9-]+|migrations\/photos\/[0-9a-f]{64})\.jpg$/);
  });

  it('у каждого кадра галереи — автор; у партнёрского — разрешение и страница партнёра', () => {
    const shots = STATEMENTS.find((s) => /INSERT INTO place_gallery_photos/.test(s))!;
    const rows = [...shots.matchAll(/\(\s*'[0-9a-f-]{36}',\s*\d+,\s*\d+,\s*\d+,\s*'[^']*',\s*'([^']*)',\s*('[^']*'|NULL),\s*('[^']*'|NULL),\s*'([^']+\.jpg)'\)/g)];
    expect(rows).toHaveLength(10);
    for (const [, author, license, source, key] of rows) {
      expect(author, key).toMatch(/^(Край Вулканов|Местечко Камчатка|владелец платформы)$/);
      if (author === 'владелец платформы') {
        expect(key).toMatch(/^migrations\/photos\//);
      } else {
        expect(license).toBe("'с разрешения туроператора'");
        expect(source).toBe(author === 'Край Вулканов' ? "'https://vedarai.ru/operators/volcanoesland'" : "'https://vedarai.ru/operators/mestechko'");
      }
    }
    const hero = STATEMENTS.find((s) => /INSERT INTO ai_route_images/.test(s))!;
    expect(hero).toMatch(/'Край Вулканов', 'с разрешения туроператора', NULL::text, 'https:\/\/vedarai\.ru\/operators\/volcanoesland'/);
    expect(hero).toMatch(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)\s+OR ai_route_images\.prompt = EXCLUDED\.prompt/);
  });

  it('снимки владельца — те, что он ставил озеру и Кутхиным Батам (958)', () => {
    const owner = keys.filter((k) => k.startsWith('migrations/photos/'));
    expect(owner).toHaveLength(2);
    const own = readFileSync(join(ROOT, 'migrations/958_owner_photos_seven_places.sql'), 'utf-8');
    for (const k of owner) expect(own, k).toContain(`'${k}'`);
  });

  it('партнёрские залиты прогоном 10 и это те же байты, что на их турах', () => {
    expect(marker.run).toBeGreaterThanOrEqual(10);
    const partner = keys.filter((k) => k.startsWith('photos/'));
    expect(partner.sort()).toEqual(Object.keys(ORIGIN).sort());
    const uploaded = new Map(marker.items.map((i) => [i.key, i.file]));
    const tours = ['1177_volcanoesland_photos_and_card_public.sql', '1217_mestechko_tours.sql']
      .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf-8')).join('\n');
    for (const k of partner) {
      const file = uploaded.get(k);
      expect(file, k).toBeTruthy();
      expect(readFileSync(join(ROOT, file!)).equals(readFileSync(join(ROOT, 'public/images', ORIGIN[k]))), k).toBe(true);
      expect(tours, ORIGIN[k]).toContain(ORIGIN[k].split('/')[1]);
    }
  });

  it('кадры Ксудача и вертолёта на поляне с той же экскурсии не взяты: место по кадру не определить', () => {
    const notHere = ['01', '03', '04', '05'].map((n) => readFileSync(join(ROOT, `public/images/mestechko/kurilskoe-ozero-${n}.jpg`)));
    for (const k of Object.keys(ORIGIN)) {
      const copy = readFileSync(join(ROOT, marker.items.find((i) => i.key === k)!.file));
      for (const m of notHere) expect(copy.equals(m), k).toBe(false);
    }
  });
});

describe('статья «Южно-Камчатский заказник»', () => {
  const SLUG = 'yuzhno-kamchatskij-zakaznik';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const all = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с карточками заказника, озера и Кутхиных Батов и со страницей заказника', () => {
    for (const id of [CARD, KURILE, KUTKH]) expect(chronicleForPlace(id).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('yuzhno-kamchatsky-zakaznik').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toContain(`/places/${slugify(CARD_ROW.name!)}`);
  });

  it('каждая веха — в тексте, годы по порядку; года имени Шпиленка нет', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(all).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(all).not.toMatch(/присвоен/);
  });

  it('страница: главный кадр партнёра с подписью, цитата Крашенинникова, переходы', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Южно-Камчатский заказник');
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/yuzhno-kamchatskij-zakaznik/kraj-vulkanov-tablichka-kurilskoe-ozero.jpg');
    const figure = img.closest('figure')!;
    expect(within(figure).getByRole('link', { name: 'Край Вулканов' }).getAttribute('href')).toBe('https://vedarai.ru/operators/volcanoesland');
    expect(figure.textContent).toMatch(/Край Вулканов · с разрешения туроператора/);
    expect(text()).toMatch(/С\. П\. Крашенинников, «Описание земли Камчатки»/);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      (article.links ?? []).map((l) => l.href),
    );
  });
});
