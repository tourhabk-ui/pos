/**
 * Национальный парк «Вулканы Камчатки» — карточки двух его кластеров
 * (миграция 1250, владелец 14.10: «Бери по порядку схему… без моих
 * подтверждений»).
 *
 * Держится то, что делает правку правдой:
 *  - имя парка и дата постановления — из его текста (Интерфакс, проба 874);
 *    номера постановления в прочитанном нет — он не пишется нигде;
 *  - порядок разрешений по-прежнему «не объявлен»: положение о парке
 *    Минприроды утверждает в течение шести месяцев;
 *  - «Ключевского» среди мест не было — он заводится с новым id и только
 *    если живой карточки с тем же именем нет;
 *  - заметка о Курильском озере на карточке «Южно-Камчатского» уходит в
 *    архив, и только пока она прежняя: озеро — федеральный заказник;
 *  - режим 47 мест переписывается только поверх текста 1245; у Мутновского
 *    — третьей строкой запрет спуска в кратер (сайт парка, 2022);
 *  - высоту Ключевской сопки карточка не называет: источники расходятся;
 *  - снимки — только партнёров и владельца, у каждого автор, партнёрские —
 *    те же байты, что на их турах, и без кадров с чужим водяным знаком;
 *  - страница «Южно-Камчатского» включается, а маршрут у Курильского озера
 *    получает имя заказника.
 * Экран судится рендером: блок режима, «Как добраться», оговорка на
 * маршруте, статья летописи.
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
import { composeAccessText } from '@/lib/places/access-text';
import { descriptionVoice } from '@/lib/places/description-voice';
import { locationTypeLabel } from '@/lib/places/location-types';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { parkKindLabel } from '@/lib/parks/park-kind';
import { federalizedPark } from '@/lib/safety/park-permit';
import { slugify } from '@/lib/text/slugify';
import { insertValues, setValues } from '../helpers/migration-sql';

afterEach(cleanup);

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1250_volcanoes_national_park_cards.sql'), 'utf-8');
const KL = '1c93607e-9a9e-4abc-a7dc-0a1b774c21d0';
const YK = 'd9059e8a-4c59-4baf-9be5-cae2fa33f810';
const MUT = 'acb8f5d3-9b44-48ec-9a81-1c8c71e451b9';

/** Тело миграции без комментариев — судим то, что исполнится. */
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
/** Операторы: конец — «;» в конце строки (в текстах «;» бывает и внутри). */
const STATEMENTS = BODY.split(/;\s*\n/);

const placeInsert = STATEMENTS.find((s) => /INSERT INTO places \(/.test(s))!;
const KL_ROW = insertValues(placeInsert);
const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const ykText = updatesOf(YK).find((s) => /\n\s*description\s*=/.test(s))!;
const YK_SET = setValues(ykText);
const ykEco = updatesOf(YK).find((s) => /eco_zone = 'national_park'/.test(s))!;
const mutRules = updatesOf(MUT).find((s) => /eco_rules\s*=/.test(s))!;
const generalRules = STATEMENTS.find((s) => /UPDATE places\s/.test(s) && /WHERE eco_zone = 'national_park'/.test(s))!;
const RULES = setValues(generalRules).eco_rules!;
const MUT_RULES = setValues(mutRules).eco_rules!;
const parkUpdate = (slug: string) => STATEMENTS.find((s) => /UPDATE parks/.test(s) && s.includes(`slug = '${slug}'`))!;

describe('справка по постановлению — без выдуманного номера', () => {
  it('имя, дата, ведомство названы; порядок разрешений «не объявлен»', () => {
    for (const t of [RULES, KL_ROW.description!, YK_SET.description!]) {
      expect(t).toMatch(/национальн\S* парк\S* «Вулканы Камчатки»/i);
      expect(t).toMatch(/от 9 октября 2026 года/);
      expect(t).toMatch(/Минприроды России/);
      expect(t).toMatch(/ещё не объявлен/);
    }
  });

  it('номера постановления 2026 года нет ни в одной строке — в источниках его нет', () => {
    for (const sentence of BODY.split(/(?<=[.;])\s/)) {
      if (/2026/.test(sentence)) expect(sentence, sentence).not.toMatch(/№\s*\d/);
    }
  });

  it('голос справки — у описаний, сути, «как добраться» и справочника парков', () => {
    const texts = [
      KL_ROW.description, KL_ROW.essence, KL_ROW.access_info,
      YK_SET.description, YK_SET.essence, YK_SET.access_info,
      setValues(parkUpdate('klyuchevskoy')).description, setValues(parkUpdate('yuzhno-kamchatsky')).description,
    ];
    for (const t of texts) {
      expect(t).toBeTruthy();
      expect(descriptionVoice(t).voice, t!.slice(0, 60)).toBe('plain');
    }
  });

  it('высоту Ключевской сопки карточки не называют: 4850 у парка, 4750 у платформы', () => {
    for (const t of [KL_ROW.description!, KL_ROW.essence!, setValues(parkUpdate('klyuchevskoy')).description!]) {
      expect(t).not.toMatch(/4\s?[78]50/);
    }
  });
});

describe('Парк «Ключевской» — новая карточка', () => {
  it('новый id, тип «Национальный парк», точка Nominatim внутри контура OSM 21624151', () => {
    expect(KL_ROW.id).toBe(KL);
    expect(KL_ROW.name).toBe('Парк «Ключевской»');
    expect(locationTypeLabel(KL_ROW.location_type!)).toBe('Национальный парк');
    expect([KL_ROW.lat, KL_ROW.lng]).toEqual(['55.9142783', '160.5652711']);
    expect(KL_ROW.coord_source).toBe('external');
  });

  it('заводится, только если живой карточки с этим именем нет', () => {
    expect(placeInsert).toMatch(/WHERE NOT EXISTS \([\s\S]*q\.merged_into_id IS NULL[\s\S]*'природный парк «ключевской»'/);
    expect(placeInsert).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('режим и разрешение: национальный парк, своей ссылки нет; заметка Кузьмича — пустая строка', () => {
    expect(KL_ROW.eco_zone).toBe('national_park');
    expect(KL_ROW.eco_permit_required).toBe('TRUE');
    expect(KL_ROW.eco_permit_url).toBeNull();
    expect(KL_ROW.eco_rules).toBe(RULES);
    expect(KL_ROW.kuzmich_review).toBe('');
  });

  it('адрес статьи летописи совпадает с адресом, который даёт миграция', () => {
    expect(BODY).toMatch(/SET slug = translit_ru_slug\(p\.name\)\s+WHERE p\.id::text = '1c93607e/);
    expect(slugify(KL_ROW.name!)).toBe('park-klyuchevskoj');
  });

  it('профиль безопасности: медведи и газы, регистрация; выдуманных умолчаний нет', () => {
    const profile = STATEMENTS.find((s) => /INSERT INTO location_safety_profile/.test(s))!;
    expect(profile).toMatch(/ARRAY\['bears', 'volcanic_gas'\]::text\[\], TRUE, 'manual'/);
    expect(profile).toMatch(/SELECT p\.ark_id, NULL, NULL, NULL,\s+NULL, NULL, NULL, NULL,/);
  });

  it('«Как добраться»: записанное, регистрация в МЧС и разрешение национального парка', () => {
    const lines = composeAccessText({
      name: KL_ROW.name!, lat: 55.9142783, lng: 160.5652711, district: null, zone: KL_ROW.zone,
      accessInfo: KL_ROW.access_info, routes: [], registrationRequired: true,
      eco: { zone: 'national_park', permitRequired: true }, toursCount: 0,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/в 20 км к востоку от посёлка Козыревск/);
    expect(text).toMatch(/порядок национального парка ещё не объявлен/);
    expect(text).toMatch(/национального парка/);
  });
});

describe('Парк «Южно-Камчатский» — заметка о Курильском озере в архив', () => {
  it('переписывается, только пока там прежняя заметка; заметка уходит в архив с причиной', () => {
    expect(ykText).toMatch(/AND description LIKE 'Три дня на кордоне у Курильского озера%'/);
    expect(ykText).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
    expect(YK_SET.description_withdrawn_reason).toMatch(/федеральный заказник, не парк/);
  });

  it('о парке, а не о заказнике: Курильского озера в справке нет, кратер Мутновского — запрет', () => {
    expect(YK_SET.description).not.toMatch(/Курильск/);
    expect(YK_SET.description).toMatch(/спускаться в кратер Мутновского запрещено и опасно/);
    expect(YK_SET.access_info).toMatch(/Спускаться в кратер Мутновского запрещено/);
  });

  it('имя, тип и зона — только поверх прежних', () => {
    const [name, type, zone] = ['name', 'location_type', 'zone'].map((c) =>
      updatesOf(YK).find((s) => new RegExp(`SET ${c} = `).test(s))!);
    expect(name).toMatch(/SET name = 'Парк «Южно-Камчатский»'[\s\S]*AND name = 'Природный парк Южно-Камчатский'/);
    expect(type).toMatch(/SET location_type = 'national_park'[\s\S]*AND location_type = 'forest'/);
    expect(zone).toMatch(/SET zone = 'southern'[\s\S]*AND zone = 'western'/);
    expect(placeZoneLabel('southern')).toBe('Южная Камчатка');
  });

  it('заметка Кузьмича о «западной части» снимается — она написана по заметке о заказнике', () => {
    const k = updatesOf(YK).find((s) => /kuzmich_review = ''/.test(s))!;
    expect(k).toMatch(/kuzmich_review LIKE 'Западная часть парка — это не прогулка%'/);
  });

  it('режим: шаблон заказника → национальный парк, три строки с запретом спуска в кратер', () => {
    expect(ykEco).toMatch(/AND eco_zone = 'zakaznik'\s+AND eco_rules LIKE 'Государственный природный заказник — охраняются места нереста лосося%'/);
    expect(setValues(ykEco).eco_rules).toBe(MUT_RULES);
  });
});

describe('режим мест обоих кластеров', () => {
  it('переписывается только поверх текста 1245', () => {
    expect(generalRules).toMatch(/AND eco_rules LIKE 'С октября 2026 года — национальный парк в ведении Минприроды России: постановлением Правительства природные парки «Ключевской» и «Южно-Камчатский» объединены%'/);
    const r1245 = readFileSync(join(ROOT, 'migrations/1245_volcanoes_national_park.sql'), 'utf-8');
    expect(r1245).toContain("'С октября 2026 года — национальный парк в ведении Минприроды России: постановлением Правительства природные парки «Ключевской» и «Южно-Камчатский» объединены в федеральную территорию");
  });

  it('блок режима: «Национальный парк», две строки — имя с датой и «не объявлено»', () => {
    render(<PlaceEco eco={{ zone: 'national_park', permitRequired: true, rules: RULES, permitUrl: null }} placeName="Вулкан Толбачик" />);
    expect(screen.getByText('Национальный парк')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^Национальный парк «Вулканы Камчатки» в ведении Минприроды России: создан постановлением Правительства России от 9 октября 2026 года/);
    expect(items[1]).toMatch(/положение о парке Минприроды должно утвердить в течение шести месяцев/);
  });

  it('Мутновский: третьей строкой — запрет спуска в кратер, и раньше общего правила', () => {
    expect(BODY.indexOf(mutRules)).toBeLessThan(BODY.indexOf(generalRules));
    expect(mutRules).toMatch(/AND eco_rules LIKE 'С октября 2026 года — национальный парк в ведении Минприроды России%'/);
    render(<PlaceEco eco={{ zone: 'national_park', permitRequired: true, rules: MUT_RULES, permitUrl: null }} placeName="Вулкан Мутновский" />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items[2]).toMatch(/^Спускаться в кратер Мутновского запрещено и опасно: в 2022 году/);
  });

  it('Мутновский: профиль из шаблона — газы, термальные зоны, нестабильный грунт', () => {
    const p = STATEMENTS.find((s) => /UPDATE location_safety_profile/.test(s) && s.includes(`'${MUT}'`))!;
    expect(p).toMatch(/ARRAY\['volcanic_gas', 'thermal', 'unstable_ground'\]/);
    expect(p).toMatch(/AND lsp\.profile_source = 'type_template'/);
  });
});

describe('справочник парков и маршрут у Курильского озера', () => {
  it('оба — «Национальный парк „Вулканы Камчатки“ — …», только поверх имён 1245', () => {
    const kl = parkUpdate('klyuchevskoy');
    const yk = parkUpdate('yuzhno-kamchatsky');
    expect(kl).toMatch(/AND display_name = 'Национальный парк — «Ключевской»'/);
    expect(yk).toMatch(/AND display_name = 'Национальный парк — «Южно-Камчатский»'/);
    for (const s of [kl, yk]) {
      expect(parkKindLabel(setValues(s).display_name!)).toBe('Национальный парк');
      expect(setValues(s).display_name).toMatch(/^Национальный парк «Вулканы Камчатки» — «/);
    }
  });

  it('страница «Южно-Камчатского» включается; ссылка разрешения — та же, что у «Ключевского»', () => {
    const yk = setValues(parkUpdate('yuzhno-kamchatsky'));
    expect(yk.is_active).toBe('TRUE');
    expect(parkUpdate('yuzhno-kamchatsky')).toMatch(/permit_url = COALESCE\(permit_url, 'https:\/\/vulcanikamchatki\.ru\/novosti\/20222029\/'\)/);
    expect(yk.description).toMatch(/Курильское озеро — не здесь: это Южно-Камчатский федеральный заказник/);
  });

  it('«Тайны Курильского озера» — маршрут заказника, и только этот маршрут', () => {
    const r = STATEMENTS.find((s) => /UPDATE kamchatka_routes/.test(s))!;
    expect(r).toMatch(/SET park_name = 'Южно-Камчатский заказник федерального значения'/);
    expect(r).toMatch(/WHERE id::text = 'b6b37731-f9f9-4db1-8ae6-847ab9ed5e60'\s+AND park_name = 'Южно-Камчатский'\s+AND title = 'Тайны Курильского озера'/);
    // Оговорка о национальном парке на его карточке больше не встаёт.
    expect(federalizedPark('Южно-Камчатский заказник федерального значения', 'Тайны Курильского озера')).toBeNull();
  });
});

describe('снимки 1250 — партнёров и владельца', () => {
  const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
    items: Array<{ file: string; key: string }>;
  };
  const keys = [...new Set([...BODY.matchAll(/'((?:migrations\/)?photos\/[a-z0-9/_.-]+\.jpg)'/g)].map((m) => m[1]))];
  /** Ключ хранилища → кадр на туре партнёра (миграции 1177 и 1217). */
  const ORIGIN: Record<string, string> = {
    'photos/vulkany-kamchatki/kraj-vulkanov-tri-vulkana-nad-lavovym-polem.jpg': 'volcanoesland/treking-podnozhie-klyuchevskoy-02.jpg',
    'photos/vulkany-kamchatki/kraj-vulkanov-shlakovye-konusy-u-podnozhiya.jpg': 'volcanoesland/treking-podnozhie-klyuchevskoy-01.jpg',
    'photos/vulkany-kamchatki/kraj-vulkanov-snezhnik.jpg': 'volcanoesland/treking-podnozhie-klyuchevskoy-05.jpg',
    'photos/vulkany-kamchatki/kraj-vulkanov-klyuchevskaya-gruppa-s-vozduha.jpg': 'volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-05.jpg',
    'photos/vulkany-kamchatki/kraj-vulkanov-suhostoj-u-tolbachika.jpg': 'volcanoesland/ploskiy-tolbachik-01.jpg',
    'photos/vulkany-kamchatki/mestechko-shlakovye-konusy-tolbachika.jpg': 'mestechko/tolbachik-standard-05.jpg',
    'photos/vulkany-kamchatki/mestechko-krater-gorelogo.jpg': 'mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-03.jpg',
    'photos/vulkany-kamchatki/mestechko-ozero-v-kratere-gorelogo.jpg': 'mestechko/vulkan-gorelyy-05.jpg',
    'photos/vulkany-kamchatki/mestechko-fumaroly-mutnovskogo.jpg': 'mestechko/oblet-vilyuchinskiy-mutnovskiy-gorelyy-01.jpg',
  };

  it('ни одного кадра Commons: ключи — снимки владельца или партнёров', () => {
    expect(BODY).not.toMatch(/commons\.wikimedia\.org|'wikimedia'\s*,\s*\d/);
    for (const k of keys) expect(k, k).toMatch(/^(photos\/vulkany-kamchatki\/(kraj-vulkanov|mestechko)-[a-z0-9-]+|migrations\/photos\/[0-9a-f]{64})\.jpg$/);
  });

  it('у каждого кадра — автор; у партнёрского — разрешение и страница партнёра', () => {
    const rows = [
      ...STATEMENTS.filter((s) => /INSERT INTO (ai_route_images|place_gallery_photos)/.test(s))
        .flatMap((s) => [...s.matchAll(/\(\s*'[^']*',\s*(?:\d+,\s*\d+,\s*\d+,\s*'[^']*',\s*|'[^']*',\s*)'([^']*)',\s*('[^']*'|NULL),\s*('[^']*'|NULL),\s*'([^']+\.jpg)'/g)]),
    ];
    expect(rows.length).toBe(11);
    for (const [, author, license, source, key] of rows) {
      expect(author, key).toMatch(/^(Край Вулканов|Местечко Камчатка|владелец платформы)$/);
      if (author === 'владелец платформы') {
        expect(key).toMatch(/^migrations\/photos\//);
      } else {
        expect(license).toBe("'с разрешения туроператора'");
        expect(source).toBe(author === 'Край Вулканов' ? "'https://vedarai.ru/operators/volcanoesland'" : "'https://vedarai.ru/operators/mestechko'");
      }
    }
  });

  it('снимки владельца — те, что он уже ставил Мутновскому и Ходутке (958)', () => {
    const owner = keys.filter((k) => k.startsWith('migrations/photos/'));
    expect(owner).toHaveLength(2);
    const own = readFileSync(join(ROOT, 'migrations/958_owner_photos_seven_places.sql'), 'utf-8');
    for (const k of owner) expect(own, k).toContain(`'${k}'`);
  });

  it('партнёрские залиты до миграции и это те же байты, что на их турах', () => {
    const partner = keys.filter((k) => k.startsWith('photos/'));
    expect(partner.sort()).toEqual(Object.keys(ORIGIN).sort());
    const uploaded = new Map(marker.items.map((i) => [i.key, i.file]));
    const tours = ['1177_volcanoesland_photos_and_card_public.sql', '1217_mestechko_tours.sql']
      .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf-8')).join('\n');
    for (const k of partner) {
      const file = uploaded.get(k);
      expect(file, k).toBeTruthy();
      const copy = readFileSync(join(ROOT, file!));
      const original = readFileSync(join(ROOT, 'public/images', ORIGIN[k]));
      expect(copy.equals(original), k).toBe(true);
      expect(tours, ORIGIN[k]).toContain(ORIGIN[k].split('/')[1]);
    }
  });

  it('кадры с чужим водяным знаком (© Holger Liebermann на «подножии» 03 и 04) не взяты', () => {
    const marked = ['03', '04'].map((n) => readFileSync(join(ROOT, `public/images/volcanoesland/treking-podnozhie-klyuchevskoy-${n}.jpg`)));
    for (const k of Object.keys(ORIGIN)) {
      const copy = readFileSync(join(ROOT, marker.items.find((i) => i.key === k)!.file));
      for (const m of marked) expect(copy.equals(m), k).toBe(false);
    }
  });
});

describe('статья «Национальный парк „Вулканы Камчатки“»', () => {
  const SLUG = 'vulkany-kamchatki';
  const article = CHRONICLE_BY_SLUG[SLUG];
  const text = article.sections
    .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
    .join('\n');

  it('связана с обеими карточками и обеими страницами парков', () => {
    expect(chronicleForPlace(KL).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPlace(YK).map((a) => a.slug)).toContain(SLUG);
    expect(chronicleForPark('klyuchevskoy').map((a) => a.slug)).toEqual([SLUG]);
    expect(chronicleForPark('yuzhno-kamchatsky').map((a) => a.slug)).toEqual([SLUG]);
    expect((article.links ?? []).map((l) => l.href)).toContain(`/places/${slugify(KL_ROW.name!)}`);
  });

  it('каждая веха — в тексте, годы по порядку', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it('постановление 2026 года — с датой и без номера; площадь — из его текста', () => {
    expect(text).toContain('от 9 октября 2026 года');
    expect(text).toContain('887 690,1226 гектара');
    for (const sentence of text.split(/(?<=[.;])\s/)) {
      if (/2026/.test(sentence)) expect(sentence, sentence).not.toMatch(/№\s*\d/);
    }
    // Расхождение площадей названо, а не спрятано.
    expect(text).toMatch(/486 900 и 375 981 гектар — вместе меньше, чем площадь национального парка/);
  });

  it('«Налычево» и «Быстринский» в национальный парк не вошли', () => {
    expect(text).toMatch(/«Налычево» и «Быстринский» в него не вошли/);
  });

  it('страница: главного кадра нет до согласия партнёра (15.10); даты и переходы на месте', async () => {
    const { container } = render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Национальный парк «Вулканы Камчатки»');
    // Кадр «Местечка Камчатка» снят, своего снимка этих вулканов у владельца
    // нет — пустое место, а не чужой кадр и не подпись без снимка.
    expect(article.hero).toBeUndefined();
    expect(container.querySelector('figure')).toBeNull();
    expect(container.innerHTML).not.toMatch(/mestechko|Местечко Камчатка/);
    const dates = screen.getByRole('region', { name: 'Главные даты' });
    expect(within(dates).getAllByRole('listitem')).toHaveLength(article.timeline!.length);
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(
      (article.links ?? []).map((l) => l.href),
    );
  });
});
