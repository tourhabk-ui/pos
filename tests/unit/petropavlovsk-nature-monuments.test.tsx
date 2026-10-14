/**
 * Памятники у Петропавловска (14.10, владелец: «Бери по порядку схему»;
 * миграция 1256) — первая партия памятников природы края.
 *
 * Держится то, что делает правку правдой:
 *  - справки — по Википедии, голосом справки; сочинения уходят в архив с
 *    причиной и только пока текст прежний; числа боя 1854 года, в которых
 *    источники расходятся, на карточки не переносятся;
 *  - точки мемориала и батареи переезжают на памятники по OSM — только с
 *    прежних точных координат; точки сопки, скал и острова не трогаются;
 *  - режим «Памятник природы» — там, где его называет источник (сопка,
 *    скалы), с разрешением «не записано»; острову категорию не выдумываем, а
 *    неверный режим «нет» снимаем;
 *  - «не записано» доходит до экрана как «не записано»: загрузчик карточки
 *    не делает из NULL «не нужно», строка «Разрешение» не отвечает «не
 *    требуется»;
 *  - снимок — только партнёрский, с подписью, те же байты, что на его туре.
 * Экран судится рендером и вызовом загрузчика карточки на подменённой базе.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const query = vi.fn();
vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/places/aliases', async (orig) => ({
  ...(await orig<typeof import('@/lib/places/aliases')>()),
  resolveMergedTarget: vi.fn(async () => null),
}));

import PlaceEco from '@/components/places/PlaceEco';
import PlaceSafety from '@/components/places/PlaceSafety';
import { loadPlaceDetail } from '@/lib/places/place-detail';
import { composeAccessText } from '@/lib/places/access-text';
import { ownPermitOf, permitNotRequired } from '@/lib/places/own-permit';
import { descriptionVoice } from '@/lib/places/description-voice';
import { chronicleForPlace } from '@/lib/chronicle/articles';
import { distanceKm } from '@/lib/geo/kamchatka';
import type { PlaceEco as EcoData, PlaceSafety as SafetyData } from '@/components/places/types';
import { migrationBody, migrationStatements, setValues, insertValues } from '../helpers/migration-sql';

afterEach(cleanup);

const ROOT = process.cwd();
const BODY = migrationBody(readFileSync(join(ROOT, 'migrations/1256_petropavlovsk_nature_monuments.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

const SOPKA = '51598b80-6b92-48d9-beb4-019f824524c9';
const MEMORIAL = 'f1a2b3c4-d5e6-4789-abcd-ef0123456789';
const BATTERY = 'a2b3c4d5-e6f7-4890-bcde-f01234567890';
const BRATYA = 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0';
const STARICHKOV = '4dd86a74-d010-4ff4-81ad-23af3ba966a5';
const TEXTED = [SOPKA, MEMORIAL, BRATYA, STARICHKOV];

const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const textUpdate = (id: string) => updatesOf(id).find((s) => /(?:\n|\bSET)\s*description\s*=/.test(s))!;
const coordUpdate = (id: string) => updatesOf(id).find((s) => /SET lat = /.test(s));
const TEXT = (id: string) => setValues(textUpdate(id));

// Точки OSM (проба 916) и координата статьи Википедии о сопке (проба 920).
const OSM_SUMMIT = { lat: 53.0205933, lng: 158.6430938 };         // node 2111959809, 103 м
const OSM_CHAPEL = { lat: 53.0215157, lng: 158.6452159 };         // way 1188381839, 1912
const OSM_BATTERY_MODEL = { lat: 53.0144722, lng: 158.6415548 };  // node 4392870396
const OSM_III_BATTERY = { lat: 53.0149906, lng: 158.6422127 };    // way 843317516, «Героям III-й батареи»
const WIKI_SOPKA = { lat: 53.02027778, lng: 158.64222222 };

const point = (stmt: string) => {
  const m = /SET lat = ([\d.]+), lng = ([\d.]+)/.exec(stmt)!;
  return { lat: Number(m[1]), lng: Number(m[2]) };
};
const guardPoint = (stmt: string) => {
  const m = /abs\(lat - ([\d.]+)\) < 0\.000001 AND abs\(lng - ([\d.]+)\) < 0\.000001/.exec(stmt)!;
  return { lat: Number(m[1]), lng: Number(m[2]) };
};

describe('справки по источникам вместо сочинений', () => {
  it('каждая из четырёх карточек получает справку голосом справки — описание, суть и «как добраться»', () => {
    for (const id of TEXTED) {
      const v = TEXT(id);
      for (const f of ['description', 'essence', 'access_info'] as const) {
        expect(v[f], `${id} ${f}`).toBeTruthy();
        expect(descriptionVoice(v[f]).voice, `${id} ${f}: ${descriptionVoice(v[f]).markers}`).toBe('plain');
      }
      expect(v.source_name, id).toMatch(/^Википедия — «/);
      expect(v.source_url, id).toMatch(/^https:\/\/ru\.wikipedia\.org\/wiki\//);
    }
  });

  it('пустые после 1247 карточки сопки и мемориала заполняются, только пока пусты и в архиве их дневник', () => {
    expect(textUpdate(SOPKA)).toMatch(/AND description IS NULL\s+AND regexp_replace\(description_withdrawn, '\^\\s\+', ''\) LIKE 'Поднимаюсь по склону Никольской%'/);
    expect(textUpdate(MEMORIAL)).toMatch(/AND description IS NULL\s+AND regexp_replace\(description_withdrawn, '\^\\s\+', ''\) LIKE 'Поднимаешься по тропе, и сразу в лицо%'/);
  });

  it('сочинения скал и острова уходят в архив с причиной — и только пока текст прежний', () => {
    for (const [id, head] of [[BRATYA, 'Скалы Три брата — три отдельно стоящие базальтовые скалы%'],
                              [STARICHKOV, 'Лодка подошла к скалистой стене%']] as const) {
      const s = textUpdate(id);
      expect(s).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
      expect(TEXT(id).description_withdrawn_reason).toMatch(/миграция 1256$/);
      expect(s).toContain(`LIKE '${head}'`);
    }
  });

  it('числа — из источника', () => {
    const sopka = TEXT(SOPKA).description!;
    for (const n of ['103 метра', '1983 году', '1964 года', 'больше 300 лет', 'часовня 1912 года', '35 защитников',
                     '38 английских и французских моряков', '1959 году', '1967 году', '1937 году', 'С 1961 по 2005 год',
                     '2018–2019 годах', '1843 году', '1787 году']) {
      expect(sopka, n).toContain(n);
    }
    expect(TEXT(STARICHKOV).description).toMatch(/147 метров/);
    expect(TEXT(BRATYA).description).toMatch(/не раньше 16 и не позже 14 миллионов лет назад/);
  });

  it('сколько было десанта и защитников, источники называют по-разному — на карточках этих чисел нет', () => {
    for (const id of TEXTED) {
      const t = TEXT(id).description!;
      expect(t, id).not.toMatch(/более 700|около 300 (?:защитник|человек)|около тысячи|около 350|210 убитых|400 убитых/);
    }
  });

  it('Три Брата: без высоты, которой нет в источнике, и без «базальтовых скал» — это останцы туфов', () => {
    const t = TEXT(BRATYA);
    for (const f of [t.description, t.essence]) {
      expect(f).not.toMatch(/15–20|высотой/);
      expect(f).not.toMatch(/базальтовые скалы/);
    }
    expect(t.description).toMatch(/абразионные останцы/);
    expect(t.description).toMatch(/осадочные базальтовые туфы завойковского вулканического комплекса/);
  });

  it('остров Старичков: виды птиц — со ссылкой на того, кто их назвал', () => {
    const t = TEXT(STARICHKOV).description!;
    expect(t).toMatch(/По описанию туроператора «Местечко Камчатка», на острове 44 гнездовые колонии/);
    expect(TEXT(STARICHKOV).source_name).toMatch(/виды птиц — описание тура «Местечко Камчатка»/);
    // Калана в сочинении «прямо под бортом» источники не называют.
    expect(t).not.toMatch(/калан/i);
  });
});

describe('точки: на памятники по OSM — и только с прежних координат', () => {
  it('мемориал: с точки в 1,6 км к югу — на часовню, главный памятник по Википедии', () => {
    const s = coordUpdate(MEMORIAL)!;
    const from = guardPoint(s);
    const to = point(s);
    expect(distanceKm(from, OSM_CHAPEL)).toBeGreaterThan(1.5);
    expect(distanceKm(to, OSM_CHAPEL)).toBeLessThan(0.005);
    expect(distanceKm(to, OSM_SUMMIT)).toBeLessThan(0.3);
    expect(s).toMatch(/coord_source = 'external'/);
  });

  it('батарея: прежняя точка — координата статьи о самой сопке, новая — макет батареи у памятника «Героям III-й батареи»', () => {
    const s = coordUpdate(BATTERY)!;
    expect(distanceKm(guardPoint(s), WIKI_SOPKA)).toBeLessThan(0.02);
    const to = point(s);
    expect(distanceKm(to, OSM_BATTERY_MODEL)).toBeLessThan(0.005);
    // Справка батареи говорит «здесь открыт памятник „Героям III батареи“» — он рядом.
    expect(distanceKm(to, OSM_III_BATTERY)).toBeLessThan(0.1);
    expect(distanceKm(to, OSM_SUMMIT)).toBeGreaterThan(0.6);
  });

  it('точки сопки, скал и острова верны и не трогаются', () => {
    for (const id of [SOPKA, BRATYA, STARICHKOV]) expect(coordUpdate(id), id).toBeUndefined();
  });

  it('у переехавших точек район записывается, только если пуст', () => {
    for (const id of [MEMORIAL, BATTERY]) {
      expect(updatesOf(id).some((s) => /zone = COALESCE\(zone, 'avachinsky'\)/.test(s)), id).toBe(true);
    }
  });
});

describe('режим: «Памятник природы» там, где его называет источник', () => {
  const regimeOf = (id: string) => updatesOf(id).find((s) => /SET eco_zone = 'nature_monument'/.test(s));

  it('сопка и скалы — памятник природы, разрешение «не записано», только поверх пустоты или «нет»', () => {
    for (const id of [SOPKA, BRATYA]) {
      const s = regimeOf(id)!;
      const v = setValues(s);
      expect('eco_permit_required' in v && v.eco_permit_required === null, id).toBe(true);
      expect(v.eco_permit_url, id).toBeNull();
      expect(s, id).toMatch(/AND \(eco_zone IS NULL OR eco_zone = 'none'\)/);
    }
  });

  it('блок режима сопки: «Памятник природы», год и честное «положение не записано» — без пропуска и ссылки', () => {
    const rules = setValues(regimeOf(SOPKA)!).eco_rules;
    const eco: EcoData = { zone: 'nature_monument', permitRequired: null, rules, permitUrl: null };
    render(<PlaceEco eco={eco} placeName="Сопка Никольская" />);
    expect(screen.getByText('Памятник природы')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Памятник природы с 1983 года',
      'Положение о памятнике — границы и запреты — на платформе не записано',
    ]);
    expect(screen.queryByText('Нужен пропуск')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Как получить разрешение' })).toBeNull();
  });

  it('острову категорию не ставим: режим «нет» снимается целиком и только он', () => {
    expect(regimeOf(STARICHKOV)).toBeUndefined();
    const s = updatesOf(STARICHKOV).find((x) => /SET eco_zone = NULL/.test(x))!;
    const v = setValues(s);
    for (const f of ['eco_zone', 'eco_permit_required', 'eco_permit_url', 'eco_rules']) {
      expect(f in v && v[f] === null, f).toBe(true);
    }
    expect(s).toMatch(/AND eco_zone = 'none'/);
  });
});

describe('«не записано» — не «не нужно»: от базы до экрана', () => {
  const ARK = '4a0c1d2e-0000-4000-8000-000000001256';
  let row: Record<string, unknown>;

  beforeEach(() => {
    row = {
      id: SOPKA, ark_id: ARK, place_pk: SOPKA, slug: 'sopka-nikolskaya', name: 'Сопка Никольская',
      location_type: 'mountain', lat: '53.0195401', lng: '158.6458397', zone: 'avachinsky',
      photo_count: 0, photo_version: 1700000000, photo_url: null, images: [], gallery_urls: [],
      eco_zone: 'nature_monument', eco_permit_required: null, eco_rules: 'Памятник природы с 1983 года', eco_permit_url: null,
    };
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (/FROM places p/.test(sql) && /WHERE \(p\.ark_id::text = \$1/.test(sql)) return { rows: [row] };
      return { rows: [] };
    });
  });

  async function ecoOfCard(): Promise<EcoData> {
    const res = await loadPlaceDetail(ARK, { countView: false });
    expect(res.status).toBe(200);
    return (res.body.data as { eco: EcoData }).eco;
  }

  it('загрузчик карточки отдаёт NULL как null, а записанные «да» и «нет» — как есть', async () => {
    expect((await ecoOfCard()).permitRequired).toBeNull();
    row = { ...row, eco_permit_required: false };
    expect((await ecoOfCard()).permitRequired).toBe(false);
    row = { ...row, eco_permit_required: true };
    expect((await ecoOfCard()).permitRequired).toBe(true);
  });

  it('строка «Разрешение» при «не записано» не отвечает «не требуется»; при записанном «нет» — отвечает', async () => {
    const SAFETY: SafetyData = {
      source: 'manual',
      difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
      terrainType: null, roadType: null, roadAccessibility: null, nearestMedicalKm: null,
      emergencyAccess: null, phoneRangerMches: null, satCommunicatorRequired: null,
      rulesRequired: null, weatherThreshold: null, hazardTypes: [],
      capacityPerDay: null, optimalGroupSize: null, openFromDate: null, openToDate: null,
      requiredGear: [], connectivity: null, registrationRequired: true, medicalInfo: null,
    };
    const unknownEco = await ecoOfCard();
    expect(permitNotRequired(unknownEco)).toBe(false);
    render(<PlaceSafety safety={SAFETY} placeId="x" ownPermit={ownPermitOf(unknownEco)} permitFree={permitNotRequired(unknownEco)} />);
    expect(screen.queryByText('не требуется')).toBeNull();
    cleanup();

    row = { ...row, eco_permit_required: false };
    const freeEco = await ecoOfCard();
    render(<PlaceSafety safety={SAFETY} placeId="x" ownPermit={ownPermitOf(freeEco)} permitFree={permitNotRequired(freeEco)} />);
    expect(screen.getByText('не требуется')).toBeTruthy();
  });

  it('«Как добраться»: место на территории памятника природы — без слов о разрешении', async () => {
    const eco = await ecoOfCard();
    const lines = composeAccessText({
      name: 'Сопка Никольская', lat: 53.0195401, lng: 158.6458397, district: null, zone: 'avachinsky',
      accessInfo: null, routes: [], registrationRequired: false, eco, toursCount: 0,
    });
    expect(lines).toContain('Место на территории памятника природы.');
    expect(lines.join(' ')).not.toMatch(/разрешени/);
  });
});

describe('заметки Кузьмича, другие имена, летопись', () => {
  it('пустая строка вместо NULL у сопки, мемориала и батареи; у острова — вместо пересказа сочинения', () => {
    for (const id of [SOPKA, MEMORIAL, BATTERY]) {
      const s = updatesOf(id).find((x) => /SET kuzmich_review = ''/.test(x))!;
      expect(s, id).toMatch(/AND kuzmich_review IS NULL/);
    }
    const s = updatesOf(STARICHKOV).find((x) => /SET kuzmich_review = ''/.test(x))!;
    expect(s).toMatch(/AND kuzmich_review LIKE 'Остров Старичков — это не просто скала%'/);
  });

  it('«Сопка Любви» и «Три Брата» — другими именами, повтор не ложится', () => {
    const s = STATEMENTS.find((x) => /INSERT INTO place_aliases/.test(x))!;
    expect(s).toContain(`('${SOPKA}', 'Сопка Любви'`);
    expect(s).toContain(`('${BRATYA}', 'Три Брата'`);
    expect(s).toMatch(/ON CONFLICT \(place_id, LOWER\(TRIM\(alias\)\)\) DO NOTHING/);
  });

  it('статья «Петропавловская оборона 1854 года» по-прежнему связана со всеми тремя карточками сопки', () => {
    for (const id of [SOPKA, MEMORIAL, BATTERY]) {
      expect(chronicleForPlace(id).map((a) => a.slug), id).toContain('petropavlovskaya-oborona-1854');
    }
  });
});

describe('снимок: только партнёрский, подписан, те же байты', () => {
  const hero = STATEMENTS.find((x) => /INSERT INTO ai_route_images/.test(x))!;
  const H = insertValues(hero);

  it('главный кадр острова — «Местечко Камчатка» с его разрешения и ссылкой на страницу партнёра', () => {
    expect(hero).toMatch(new RegExp(`WHERE p\\.id::text = '${STARICHKOV}'`));
    expect(H.author).toBe('Местечко Камчатка');
    expect(H.license).toBe('с разрешения туроператора');
    expect(H.source_url).toBe('https://vedarai.ru/operators/mestechko');
    expect([H.width, H.height]).toEqual(['800', '1067']);
    // Ручной снимок и Викисклад, если они уже стоят, не перетираются.
    expect(hero).toMatch(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)\s+OR ai_route_images\.prompt = EXCLUDED\.prompt/);
  });

  it('ключ залит маркером media-to-s3, и это те же байты, что на туре партнёра', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ file: string; key: string }>;
    };
    const item = marker.items.find((i) => i.key === H.s3_key)!;
    expect(item).toBeTruthy();
    expect(existsSync(join(ROOT, item.file))).toBe(true);
    const sha = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
    expect(sha(item.file)).toBe(sha('public/images/mestechko/ostrov-starichkov-02.jpg'));
  });

  it('чужих снимков нет: ни Викисклада, ни галерей без автора', () => {
    expect(BODY).not.toMatch(/commons\.wikimedia\.org|place_gallery_photos/);
  });
});
