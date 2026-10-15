/**
 * Режим мест по контурам охраняемых территорий OSM (15.10, миграция 1289):
 * 21 место внутри Кроноцкого заповедника, 4 — Тимоновского заказника,
 * 2 — парка «Налычево», 2 — Командорского заповедника.
 *
 * Сверка place-oopt-contours (прогон 2) нашла их внутри границ, а режима у
 * них не было — на карточке Узона внутри заповедника о разрешении ни слова.
 * Держится:
 *  - режим территории — это режим каждой её точки: правила те же, что у мест
 *    той же территории в прежних партиях (1274 — Кроноцкий и Тимоновский,
 *    1243 — Командоры, 1248 — Налычево), сравнением с их текстом, а не
 *    пересказом;
 *  - поверх пустоты или «нет» 170-й и без своих правил: записанное рукой не
 *    трогается;
 *  - где граница не сверена (село Никольское и второй контур Командор, Эссо
 *    внутри «Быстринского»), режима нет вовсе;
 *  - у Налычева граница зоны свободного посещения не размечена — разрешение
 *    «не записано», и это сказано словами.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import PlaceEco from '@/components/places/PlaceEco';
import type { PlaceEco as EcoData } from '@/components/places/types';
import { migrationBody, migrationStatements, setValues } from '../helpers/migration-sql';

afterEach(cleanup);

const read = (f: string) => migrationBody(readFileSync(join(process.cwd(), 'migrations', f), 'utf-8'));
const BODY = read('1289_eco_zone_by_oopt_contours.sql');
const STATEMENTS = migrationStatements(BODY);
const PRIOR_1274 = migrationStatements(read('1274_eco_zone_by_contour_ilike_places.sql'));
const PRIOR_1243 = migrationStatements(read('1243_komandorskie_koryaksky_reserves.sql'));
const PRIOR_1248 = migrationStatements(read('1248_nalychevo_natural_park.sql'));

const blockOf = (zone: string) => STATEMENTS.find((s) => /UPDATE places p\s/.test(s) && s.includes(`SET eco_zone = '${zone}'`))!;
const idsOf = (stmt: string) => [...stmt.matchAll(/\('([0-9a-f-]{36})', '/g)].map((m) => m[1]);
const rulesOf = (stmt: string) => setValues(stmt).eco_rules!.split('\n');

/** Точки внутри контура Кроноцкого заповедника — сверка place-oopt-contours, прогон 2. */
const KRONOTSKY = [
  'dc0ad1a8', 'bd8dcdd4', '898cdc12', '5cdb784e', '9d5e4afa', '543b7feb', 'c1416d38',
  'de288759', '20d7b84d', '5694d055', 'c280a049', '075f0e9c', '33a2891a', '808de863',
  '46aa7c6e', 'af903540', '1a8e3486', 'a1790195', '775aa3de', '8c7da06e', '0cbaa99c',
];

describe('Кроноцкий заповедник: 21 место внутри контура', () => {
  const s = blockOf('federal_reserve');

  it('ровно те точки, что сверка нашла внутри контура', () => {
    expect(idsOf(s).map((id) => id.slice(0, 8)).sort()).toEqual([...KRONOTSKY].sort());
  });

  it('правила — те же, что у мест заповедника в 1274: режим территории — режим каждой её точки', () => {
    const prior = PRIOR_1274.find((x) => x.includes("SET eco_zone = 'federal_reserve'"))!;
    expect(setValues(s).eco_rules).toBe(setValues(prior).eco_rules);
    const v = setValues(s);
    expect(v.eco_permit_required).toBe('TRUE');
    expect(v.eco_permit_url).toBe('https://kronoki.ru/ru/visit/requests/');
  });

  it('на карточке — «Нужен пропуск» и путь к разрешению заповедника', () => {
    const v = setValues(s);
    const eco: EcoData = { zone: 'federal_reserve', permitRequired: true, rules: v.eco_rules, permitUrl: v.eco_permit_url };
    render(<PlaceEco eco={eco} placeName="Узон" />);
    expect(screen.getByText('Нужен пропуск')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Как получить разрешение/ }).getAttribute('href')).toBe('https://kronoki.ru/ru/visit/requests/');
    expect(document.body.textContent).toMatch(/только организованными группами с гидом/);
  });
});

describe('Тимоновский заказник и Командоры — правила своих территорий', () => {
  it('Тимоновский: как у Ново-Бакенинга (1274), разрешение «не записано»', () => {
    const s = blockOf('zakaznik');
    const prior = PRIOR_1274.find((x) => x.includes("SET eco_zone = 'zakaznik'") && x.includes('Тимоновского'))!;
    expect(rulesOf(s)[0]).toBe(rulesOf(prior)[0]);
    expect(rulesOf(s).at(-1)).toBe('Положение о заказнике — границы и запреты — на платформе не записано');
    expect(setValues(s).eco_permit_required).toBeNull();
    expect(idsOf(s)).toHaveLength(4);
  });

  it('Командоры: правила карточки парка (1243) дословно, разрешение нужно', () => {
    const s = blockOf('national_park');
    const park = rulesOf(PRIOR_1243.find((x) => x.includes("eco_zone = 'national_park'"))!);
    for (const line of rulesOf(s).slice(1)) expect(park, line).toContain(line);
    expect(setValues(s).eco_permit_required).toBe('TRUE');
    expect(idsOf(s).map((id) => id.slice(0, 8)).sort()).toEqual(['ac0321fc', 'b36757f9']);
  });
});

describe('Налычево: граница зоны свободного посещения не размечена', () => {
  it('разрешение «не записано», и это сказано строкой; общие правила — из 1248', () => {
    const s = blockOf('natural_park');
    expect(setValues(s).eco_permit_required).toBeNull();
    const lines = rulesOf(s);
    expect(lines[1]).toMatch(/входит ли в неё эта точка, у нас не размечено/);
    const park = rulesOf(PRIOR_1248.find((x) => x.includes("SET eco_zone = 'natural_park'") && x.includes('eco_permit_required = TRUE'))!);
    for (const line of lines.slice(2)) expect(park, line).toContain(line);
  });
});

describe('что не трогается', () => {
  it('каждый блок — только поверх пустоты или «нет» и без своих правил', () => {
    const blocks = STATEMENTS.filter((x) => /UPDATE places p\s/.test(x));
    expect(blocks).toHaveLength(4);
    for (const s of blocks) {
      expect(s).toMatch(/AND \(p\.eco_zone IS NULL OR p\.eco_zone = 'none'\)/);
      expect(s).toMatch(/AND p\.eco_rules IS NULL/);
    }
  });

  it('где граница не сверена — режима нет: постройки Никольского, лежбища второго контура, Эссо', () => {
    for (const id of ['d851e5bb', '4c6fc28d', '583c8f78', 'bf9f9464', 'd5e1e9c0', '27c04946', '36d5d094', 'b2c3d4e5']) {
      expect(BODY, id).not.toContain(`'${id}`);
    }
  });
});
