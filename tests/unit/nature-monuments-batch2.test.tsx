/**
 * Памятники природы, партия 2 (14.10, владелец: «Бери по порядку схему»;
 * миграция 1257) — Голубые озёра, Тимоновские источники, озеро Ажабачье.
 *
 * Здесь сочинения спорили с источником там, где от этого зависит
 * безопасность: «можно окунуться — вода градусов шестнадцать» у снеговых
 * озёр, где вода и летом около нуля; о мышьяке в Тимоновских источниках не
 * было ни слова. Держится:
 *  - справки — по Википедии, голосом справки; сочинения — в архив с причиной
 *    и только пока текст прежний; выдумка о видовой точке снимается целиком —
 *    и карточка говорит, что описание снято, не называя чужую причину;
 *  - предупреждение о мышьяке стоит везде, где его прочтут: в справке, в
 *    сути и в «как добраться»;
 *  - режим «Памятник природы» — у тех, кого им называет источник, с
 *    разрешением «не записано»; Голубым озёрам режим не ставится — две записи
 *    Википедии о них спорят;
 *  - точки не трогаются: у Голубых озёр она совпадает с OSM, у Тимоновских —
 *    сверяется отдельно.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import PlaceEco from '@/components/places/PlaceEco';
import PlaceDescription from '@/components/places/PlaceDescription';
import { descriptionVoice } from '@/lib/places/description-voice';
import type { PlaceEco as EcoData } from '@/components/places/types';
import { migrationBody, migrationStatements, setValues } from '../helpers/migration-sql';

afterEach(cleanup);

const BODY = migrationBody(readFileSync(join(process.cwd(), 'migrations/1257_nature_monuments_batch2.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

const BLUE = '6227b295-44de-4148-9571-48c185f86735';
const VIEW = 'be84e54c-f63d-4737-a6cc-8494fcd1a0eb';
const TIMON = '15bf29b0-9b1b-49c5-be1f-4c8d5d185f4e';
const AZHAB = '7498601a-86b8-4560-bf58-e6e2e751b7a8';
const BATTERY = 'a2b3c4d5-e6f7-4890-bcde-f01234567890';
const TEXTED = [BLUE, TIMON, AZHAB];

const updatesOf = (id: string) => STATEMENTS.filter((s) => /UPDATE places\s/.test(s) && s.includes(`'${id}'`));
const textUpdate = (id: string) => updatesOf(id).find((s) => /(?:\n|\bSET)\s*description\s*=/.test(s))!;
const TEXT = (id: string) => setValues(textUpdate(id));
const regimeOf = (id: string) => updatesOf(id).find((s) => /SET eco_zone = 'nature_monument'/.test(s));

describe('справки по Википедии вместо сочинений', () => {
  it('голос справки у описания, сути и «как добраться»; источник — статья Википедии', () => {
    for (const id of TEXTED) {
      const v = TEXT(id);
      for (const f of ['description', 'essence', 'access_info'] as const) {
        if (id === AZHAB && f === 'access_info') continue; // путь к озеру источник не описывает — не пишем
        expect(v[f], `${id} ${f}`).toBeTruthy();
        expect(descriptionVoice(v[f]).voice, `${id} ${f}: ${descriptionVoice(v[f]).markers}`).toBe('plain');
      }
      expect(v.source_url, id).toMatch(/^https:\/\/ru\.wikipedia\.org\/wiki\//);
    }
    expect('access_info' in TEXT(AZHAB)).toBe(false);
  });

  it('сочинения — в архив с причиной, и только пока текст прежний', () => {
    for (const [id, head] of [[BLUE, 'Тропа поднимает на плато, и открывается цепочка чаш%'],
                              [TIMON, 'Пар над Тимоновскими поднимается столбами%'],
                              [AZHAB, 'Вода здесь мутновата от взвеси%'],
                              [VIEW, 'Видовая точка на Долину голубых озёр — цепочку небольших термально-минеральных озёр%']] as const) {
      const s = textUpdate(id);
      expect(s, id).toMatch(/description_withdrawn = COALESCE\(description_withdrawn, description\)/);
      expect(TEXT(id).description_withdrawn_reason, id).toMatch(/миграция 1257$/);
      expect(s, id).toContain(`LIKE '${head}'`);
    }
  });
});

describe('Голубые озёра: вода около нуля, а не «шестнадцать»', () => {
  it('справка и суть говорят про холодную воду и не зовут купаться', () => {
    const v = TEXT(BLUE);
    expect(v.description).toMatch(/Температура воды даже летом близка к нулю/);
    expect(v.essence).toMatch(/вода даже летом близка к\s+нулю/);
    for (const f of [v.description, v.essence, v.access_info]) {
      expect(f).not.toMatch(/шестнадцат|16 °|окунуться|купа|кальцит|пощипывает/i);
    }
  });

  it('медведи в профиле — по источнику; шаблонные поля обнулены, переводится только шаблон', () => {
    const s = STATEMENTS.find((x) => /UPDATE location_safety_profile/.test(x))!;
    expect(s).toContain(`p.id::text = '${BLUE}'`);
    expect(s).toMatch(/hazard_types = ARRAY\['bears'\]/);
    for (const f of ['capacity_per_day', 'optimal_group_size', 'difficulty_level', 'terrain_type', 'road_type', 'road_accessibility']) {
      expect(s, f).toMatch(new RegExp(`${f} = NULL`));
    }
    expect(s).toMatch(/AND lsp\.profile_source = 'type_template'/);
    expect(TEXT(BLUE).description).toMatch(/возможно появление медведей/);
  });

  it('режим не ставится: статья и категория Википедии о нём спорят', () => {
    expect(updatesOf(BLUE).some((s) => /eco_zone\s*=/.test(s))).toBe(false);
    expect(TEXT(BLUE).description).toMatch(/статус природного парка\s+областного значения/);
  });

  it('видовая точка: выдумка снята целиком — и карточка говорит об этом, не называя чужую причину', () => {
    const v = TEXT(VIEW);
    expect('description' in v && v.description === null).toBe(true);
    render(<PlaceDescription name="Вид на долину Голубых озёр" essence={null} description={null} descriptionWithdrawn placeId={VIEW} />);
    expect(document.body.textContent).toMatch(/Описание этого места было написано не по источникам/);
    expect(document.body.textContent).not.toMatch(/путевая заметка|термально-минеральн/);
  });
});

describe('Тимоновские источники: мышьяк — везде, где прочтут', () => {
  it('в справке, сути и «как добраться» — пить из некоторых источников нельзя', () => {
    const v = TEXT(TIMON);
    for (const f of [v.description, v.essence, v.access_info]) {
      expect(f).toMatch(/Пить из некоторых источников нельзя/);
      expect(f).toMatch(/мышьяк/);
    }
  });

  it('температура — по источнику, от 16 до 46 °C, а не «под пятьдесят»', () => {
    const v = TEXT(TIMON);
    expect(v.description).toMatch(/от 16 до 46 °C/);
    for (const f of [v.description, v.essence, v.access_info]) expect(f).not.toMatch(/пятьдесят|50 °/);
  });

  it('режим: памятник природы на территории заказника, разрешение «не записано»', () => {
    const s = regimeOf(TIMON)!;
    const v = setValues(s);
    expect('eco_permit_required' in v && v.eco_permit_required === null).toBe(true);
    expect(s).toMatch(/AND \(eco_zone IS NULL OR eco_zone = 'none'\)/);
    const eco: EcoData = { zone: 'nature_monument', permitRequired: null, rules: v.eco_rules, permitUrl: null };
    render(<PlaceEco eco={eco} placeName="Тимоновские" />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Комплексный памятник природы регионального значения — с 1981 года; 1,1 гектара вместе с прилегающей местностью',
      'Источники — на территории Тимоновского государственного зоологического заказника',
      'Положение о памятнике и о заказнике — границы и запреты — на платформе не записано',
    ]);
    expect(screen.queryByText('Нужен пропуск')).toBeNull();
  });
});

describe('озеро Ажабачье', () => {
  it('вода прозрачная, а не «мутновата»; площадь — обоими числами источника', () => {
    const t = TEXT(AZHAB).description!;
    expect(t).toMatch(/Вода чистая и прозрачная/);
    expect(t).not.toMatch(/мутн/);
    expect(t).toMatch(/63,9 км², по более поздним данным — 56,5 км²/);
    expect(t).toMatch(/С 9\s+января 1981 года/);
  });

  it('режим: памятник природы «Озеро Ажабачье» с 1981 года, разрешение «не записано»', () => {
    const v = setValues(regimeOf(AZHAB)!);
    expect('eco_permit_required' in v && v.eco_permit_required === null).toBe(true);
    expect(v.eco_rules).toMatch(/^Памятник природы регионального значения «Озеро Ажабачье» — с 9 января 1981 года\n/);
  });
});

describe('заметки Кузьмича, точки, имена', () => {
  it('пустая строка вместо пересказа сочинения — и только пока заметка прежняя', () => {
    for (const [id, guard] of [[BLUE, "LIKE 'Тропа выводит на плато к цепочке чаш%'"],
                               [TIMON, "LIKE 'Тимоновские — место дикое, без мостков%'"],
                               [AZHAB, "LIKE 'Озеро Ажабачье — это не про отдых с удочкой%'"],
                               [BATTERY, "LIKE 'С подъёма сразу в лицо — океанский ветер%'"],
                               [VIEW, 'IS NULL']] as const) {
      const s = updatesOf(id).find((x) => /SET kuzmich_review = ''/.test(x))!;
      expect(s, id).toContain(`AND kuzmich_review ${guard}`);
    }
  });

  it('точки не трогаются: у Голубых озёр — центр контура OSM, у Тимоновских — сверка отдельно', () => {
    expect(BODY).not.toMatch(/SET lat\b/);
  });

  it('другие имена — для поиска; повтор не ложится', () => {
    const s = STATEMENTS.find((x) => /INSERT INTO place_aliases/.test(x))!;
    for (const [id, alias] of [[TIMON, 'Тимоновские источники'], [TIMON, 'Тимоновские ключи'], [AZHAB, 'Ажабачье'], [AZHAB, 'Азабачье']]) {
      expect(s).toContain(`('${id}', '${alias}'`);
    }
    expect(s).toMatch(/ON CONFLICT \(place_id, LOWER\(TRIM\(alias\)\)\) DO NOTHING/);
  });
});
