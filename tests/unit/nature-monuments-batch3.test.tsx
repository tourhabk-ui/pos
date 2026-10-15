/**
 * Памятники природы, партия 3 (15.10, владелец: «Бери по порядку схему»,
 * «по остальным местам там много неправды»; миграция 1288) — Паланское и
 * Паланские пороги, Ксудач, Ходуткинские источники и вулкан Ходутка, Арка
 * Стеллера, Костакан, Урочище Аквариум.
 *
 * Сочинения здесь спорили не только с источником, но и с собственной точкой
 * карточки: пороги «в 30 км от устья» стояли в посёлке Палана, вода озера —
 * у кордона в 55 км от озера, источники «в 10 км от посёлка» — в 83. Держится:
 *  - справки — по Википедии, голосом справки; сочинения — в архив с причиной
 *    и только пока текст прежний; где справки нет — текст снимается целиком;
 *  - точка порогов — исток Паланы из озера по OSM, и справка говорит, что
 *    пороги ниже по течению; кордон без источника прячется, а не двигается;
 *  - вода Ходуткинских источников до 88 °C — опасность «термальные» в профиле;
 *  - Арка Стеллера — имя объекта и «Район» Командор, прежнее имя — для поиска;
 *  - режим — только у тех, кого им называет источник, с разрешением
 *    «не записано», и только поверх пустоты или «нет».
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import PlaceEco from '@/components/places/PlaceEco';
import PlaceFacts from '@/components/places/PlaceFacts';
import { descriptionVoice } from '@/lib/places/description-voice';
import type { PlaceEco as EcoData, PlaceSafety } from '@/components/places/types';
import { migrationBody, migrationStatements, setValues } from '../helpers/migration-sql';

afterEach(cleanup);

const BODY = migrationBody(readFileSync(join(process.cwd(), 'migrations/1288_nature_monuments_batch3.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

const PALANA_LAKE = '22066f59-ff7f-4061-b408-3d876147ce05';
const PALANA_SPRINGS = '4a474632-d8d6-4147-9fa1-ed149edb1a62';
const CORDON = 'c23dd150-e8ec-4721-a82f-2c81c0c82d32';
const POROGI = '8ed1e7c5-df06-4bae-9c48-3be6c2890aa0';
const KSUDACH = '6e3a46a9-104d-4181-958a-2a47698f2982';
const KSUDACH_VIEW = '94220a7c-c4bb-4b16-8147-430b5e770617';
const KHODUTKA_VOLCANO = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const KHODUTKA_SPRINGS = '24ee4667-c6e0-4aa0-b3f8-27073e00822f';
const ARKA = 'd64e3e6a-72a5-4c14-adc0-588c3824f6ae';
const KOSTAKAN = '1d427c44-9f54-47da-99ff-12231705746b';
const AKVARIUM = 'fe3e16a9-bf51-4df9-aed1-27e6b15bf4cf';

/** Справки по Википедии: id → прежний текст, поверх которого она ложится (null — поверх пустоты). */
const REFERENCES: Array<[string, string | null]> = [
  [PALANA_LAKE, 'Озеро лежит среди плоской тундры%'],
  [POROGI, 'Паланские пороги — это живописный участок реки Палана%'],
  [KSUDACH, null],
  [KHODUTKA_SPRINGS, null],
  [KHODUTKA_VOLCANO, 'Пар над Ходуткинскими источниками поднимается%'],
  [ARKA, 'Командорские острова — это архипелаг в Беринговом море%'],
  [KOSTAKAN, 'Дорога к Костакану — тридцать пять километров грунтовки%'],
];

const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const textUpdate = (id: string) => updatesOf(id).find((s) => /(?:\n|\bSET)\s*description\s*=/.test(s))!;
const TEXT = (id: string) => setValues(textUpdate(id));
const regimeOf = (id: string) => updatesOf(id).find((s) => /SET eco_zone = /.test(s));

const SAFETY_EMPTY: PlaceSafety = {
  source: 'manual', difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
  terrainType: null, roadType: null, roadAccessibility: null, nearestMedicalKm: null, emergencyAccess: null,
  phoneRangerMches: null, satCommunicatorRequired: null, rulesRequired: null, weatherThreshold: null,
  hazardTypes: [], capacityPerDay: null, capacityPerDaySource: null, optimalGroupSize: null,
  openFromDate: null, openToDate: null, requiredGear: [], connectivity: null, registrationRequired: false,
  medicalInfo: null,
} as unknown as PlaceSafety;

describe('справки по Википедии вместо сочинений и пустоты', () => {
  it('голос справки у описания и сути; источник — статья Википедии', () => {
    for (const [id] of REFERENCES) {
      const v = TEXT(id);
      for (const f of ['description', 'essence'] as const) {
        expect(v[f], `${id} ${f}`).toBeTruthy();
        expect(descriptionVoice(v[f]).voice, `${id} ${f}: ${descriptionVoice(v[f]).markers}`).toBe('plain');
      }
      expect(v.source_name, id).toMatch(/^Википедия — «/);
      expect(v.source_url, id).toMatch(/^https:\/\/ru\.wikipedia\.org\/wiki\//);
      // Путь к месту ни одна статья не описывает — «как добраться» не пишется.
      expect('access_info' in v, id).toBe(false);
    }
  });

  it('сочинения — в архив с причиной и только пока текст прежний; пустые — только пока пусто', () => {
    for (const [id, head] of REFERENCES) {
      const s = textUpdate(id);
      if (head === null) {
        expect(s, id).toMatch(/AND \(description IS NULL OR btrim\(description\) = ''\)/);
        expect(s, id).not.toMatch(/description_withdrawn =/);
        continue;
      }
      expect(s, id).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
      expect(TEXT(id).description_withdrawn_reason, id).toMatch(/миграция 1288$/);
      expect(s, id).toContain(`LIKE '${head}'`);
    }
  });

  it('где справки нет — текст снимается целиком, и тоже только пока прежний', () => {
    for (const [id, head] of [[PALANA_SPRINGS, 'Паланские термальные источники расположены в 10 км от поселка Палана%'],
                              [CORDON, 'Вода здесь зелёная, будто вымытая ледником%'],
                              [KSUDACH_VIEW, '**Северная видовка на Ксудач**%']] as const) {
      const v = TEXT(id);
      expect('description' in v && v.description === null, id).toBe(true);
      expect(v.description_withdrawn_reason, id).toMatch(/миграция 1288$/);
      expect(textUpdate(id), id).toContain(`LIKE '${head}'`);
    }
  });

  it('чего в источниках нет, в справках нет: ни тундры, ни грунтовки, ни купелей', () => {
    const all = REFERENCES.map(([id]) => `${TEXT(id).description}\n${TEXT(id).essence}`).join('\n');
    expect(all).not.toMatch(/тундр|грунтов|купел|кижуч|чавыч|Ительмен|wildlife/i);
  });
});

describe('Паланский куст: точки против текстов', () => {
  it('пороги: точка — исток Паланы из озера по OSM, только пока стоит прежняя', () => {
    const s = updatesOf(POROGI).find((x) => /SET lat = /.test(x))!;
    expect(s).toMatch(/SET lat = 58\.8295541, lng = 160\.7598901/);
    expect(s).toMatch(/coord_source = 'external'/);
    expect(s).toMatch(/AND abs\(lat - 59\.0842\) < 0\.000001 AND abs\(lng - 159\.9542\) < 0\.000001/);
    expect(TEXT(POROGI).source_name).toMatch(/OSM 4599321501/);
  });

  it('пороги: справка говорит, что точка — исток, а пороги ниже, и что они — памятник природы', () => {
    const t = TEXT(POROGI).description!;
    expect(t).toMatch(/Точка на карте — исток реки из озера; пороги — ниже по течению/);
    expect(t).toMatch(/Паланские пороги — памятник природы/);
    expect(t).not.toMatch(/30 км от устья|2-3 метр|2–3 метр/);
  });

  it('кордон без источника прячется, а не двигается; сторож — id и имя', () => {
    const s = updatesOf(CORDON).find((x) => /SET is_visible = false/.test(x))!;
    expect(s).toMatch(/AND name = 'Кордон озеро Паланское'/);
    expect(s).toMatch(/AND is_visible = true/);
    expect(updatesOf(CORDON).some((x) => /SET lat = /.test(x))).toBe(false);
  });

  it('«Паланские термальные источники» остаются на месте: спорит с точкой текст, а не источник', () => {
    expect(updatesOf(PALANA_SPRINGS).some((x) => /SET lat = |is_visible = false/.test(x))).toBe(false);
  });

  it('озеро: справка по статье — предгорья у вулкана Масса, нерка, заказник с 2021 года', () => {
    const t = TEXT(PALANA_LAKE).description!;
    expect(t).toMatch(/у подножия вулкана Масса, на высоте 274 метра/);
    expect(t).toMatch(/одно из крупнейших нерестилищ нерки в Северо-Восточной Азии/);
    expect(t).toMatch(/постановлением Правительства Камчатского края № 69-П от\s+24 февраля 2021 года/);
  });
});

describe('Ходуткинские источники: вода до 88 °C', () => {
  it('справка называет температуру; в профиле — опасность «термальные», шаблонные поля обнулены', () => {
    expect(TEXT(KHODUTKA_SPRINGS).description).toMatch(/достигает 88 °C/);
    const s = STATEMENTS.find((x) => /UPDATE location_safety_profile/.test(x) && x.includes(`'${KHODUTKA_SPRINGS}'`))!;
    expect(s).toMatch(/hazard_types = ARRAY\['thermal'\]/);
    for (const f of ['capacity_per_day', 'optimal_group_size', 'difficulty_level', 'terrain_type', 'road_type', 'road_accessibility']) {
      expect(s, f).toMatch(new RegExp(`${f} = NULL`));
    }
    expect(s).toMatch(/AND lsp\.profile_source = 'type_template'/);
  });

  it('у остальных карточек партии шаблон обнуляется без новых опасностей — их источник не называет', () => {
    const s = STATEMENTS.find((x) => /UPDATE location_safety_profile/.test(x) && x.includes(`'${PALANA_LAKE}'`))!;
    expect(s).not.toMatch(/hazard_types/);
    expect(s).toMatch(/road_type = NULL/);
    expect(s).toMatch(/AND lsp\.profile_source = 'type_template'/);
  });
});

describe('Арка Стеллера: имя объекта и Командоры', () => {
  it('имя — сам объект, прежнее — другим именем для поиска', () => {
    const s = updatesOf(ARKA).find((x) => /SET name = /.test(x))!;
    expect(setValues(s).name).toBe('Арка Стеллера');
    expect(s).toMatch(/AND name = 'Арка Стеллера — Командорские острова'/);
    const aliases = STATEMENTS.find((x) => /INSERT INTO place_aliases/.test(x))!;
    expect(aliases).toContain(`('${ARKA}', 'Арка Стеллера — Командорские острова'`);
    expect(aliases).toMatch(/ON CONFLICT \(place_id, LOWER\(TRIM\(alias\)\)\) DO NOTHING/);
  });

  it('«Район» — Командорские острова, а не «Авачинский»; меняется только прежнее значение', () => {
    const s = updatesOf(ARKA).find((x) => /SET zone = /.test(x))!;
    expect(setValues(s).zone).toBe('commander');
    expect(s).toMatch(/AND zone = 'avachinsky'/);
    render(<PlaceFacts locationType="rock" zone="commander" safety={SAFETY_EMPTY} terrainType={null} />);
    expect(document.body.textContent).toMatch(/РайонКомандорские о-ва/);
    expect(document.body.textContent).not.toMatch(/Авачинск/);
  });
});

describe('заметки Кузьмича', () => {
  it('пустая строка вместо пересказа сочинения — и только пока заметка прежняя', () => {
    for (const [id, guard] of [[PALANA_LAKE, 'Озеро Паланское — суровое северное место%'],
                               [CORDON, 'Озеро Паланское — место суровое и красивое%'],
                               [POROGI, 'Паланские пороги — река с характером%'],
                               [KSUDACH_VIEW, 'Северная видовка на Ксудаче — вид на кальдеру%'],
                               [ARKA, 'Арка Стеллера — это мощная скала на краю земли%']] as const) {
      const s = updatesOf(id).find((x) => /SET kuzmich_review = ''/.test(x))!;
      expect(s, id).toContain(`AND kuzmich_review LIKE '${guard}'`);
    }
  });

  it('у Урочища Аквариум заметка по снимкам остаётся', () => {
    expect(updatesOf(AKVARIUM).some((x) => /kuzmich_review/.test(x))).toBe(false);
  });
});

describe('режим', () => {
  it('только поверх пустоты или «нет», разрешение — «не записано» (кроме парка Командор)', () => {
    const regimes = STATEMENTS.filter((x) => /UPDATE places\s/.test(x) && /SET eco_zone = /.test(x) && !x.includes(`'${ARKA}'`));
    expect(regimes.length).toBe(6);
    for (const s of regimes) {
      const v = setValues(s);
      expect('eco_permit_required' in v && v.eco_permit_required === null, s.slice(0, 120)).toBe(true);
      expect('eco_permit_url' in v && v.eco_permit_url === null, s.slice(0, 120)).toBe(true);
      expect(s).toMatch(/AND \(eco_zone IS NULL OR eco_zone = 'none'\)/);
      expect(v.eco_rules).toMatch(/на платформе не записано$/);
    }
  });

  it('Арка Стеллера — в национальном парке «Командорские острова»: разрешение парка, как у его карточки (1243)', () => {
    const s = regimeOf(ARKA)!;
    const v = setValues(s);
    expect(v.eco_zone).toBe('national_park');
    expect(v.eco_permit_required).toBe('TRUE');
    expect('eco_permit_url' in v && v.eco_permit_url === null).toBe(true);
    expect(s).toMatch(/AND \(eco_zone IS NULL OR eco_zone = 'none'\)/);
    const eco: EcoData = { zone: 'national_park', permitRequired: true, rules: v.eco_rules, permitUrl: null };
    render(<PlaceEco eco={eco} placeName="Арка Стеллера" />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/национального парка «Командорские острова»/);
    expect(items).toContain('Посещение платное и только по разрешению: его выдаёт отдел охраны национального парка в селе Никольском');
    expect(items.at(-1)).toMatch(/памятник природы регионального значения/);
  });

  it('Костакан — памятник природы на территории Тимоновского заказника по контуру OSM', () => {
    const v = setValues(regimeOf(KOSTAKAN)!);
    expect(v.eco_zone).toBe('nature_monument');
    expect(v.eco_rules!.split('\n')).toEqual([
      'Озеро Костакан — памятник природы регионального значения (Википедия — «Костакан (озеро)»); год источник не называет',
      'Озеро — на территории Тимоновского государственного зоологического заказника (контур — OpenStreetMap)',
      'Положение о памятнике и о заказнике — границы и запреты — на платформе не записано',
    ]);
  });

  it('Ходуткинские: род — тот, что назван с годом; о парке — словами источника, без вывода о разрешении', () => {
    const v = setValues(regimeOf(KHODUTKA_SPRINGS)!);
    expect(v.eco_zone).toBe('nature_monument');
    expect(v.eco_rules).toMatch(/^Памятник природы регионального значения — с 1981 года/);
    expect(v.eco_rules).toMatch(/границу парка у источников мы не сверили/);
  });

  it('Голубым озёрам режим по-прежнему не ставится: контура в OSM нет, третьего источника нет', () => {
    expect(BODY).not.toContain('6227b295-44de-4148-9571-48c185f86735');
  });

  it('Урочище Аквариум: памятник природы — по табличке у моста', () => {
    const v = setValues(regimeOf(AKVARIUM)!);
    expect(v.eco_zone).toBe('nature_monument');
    expect(v.eco_rules).toMatch(/по табличке Правительства Камчатского края у моста/);
    const eco: EcoData = { zone: 'nature_monument', permitRequired: null, rules: v.eco_rules, permitUrl: null };
    render(<PlaceEco eco={eco} placeName="Урочище Аквариум" />);
    expect(screen.getAllByRole('listitem')[0].textContent).toMatch(/«Урочище Аквариум на реке Левая Авача»/);
    expect(screen.queryByText('Нужен пропуск')).toBeNull();
  });
});
