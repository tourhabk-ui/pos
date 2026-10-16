// @vitest-environment jsdom
/**
 * Район места — по округу точки (1293, 16.10, #83).
 *
 * `places.zone` — не только строка «Район», но и адрес тревоги без своей
 * координаты: зональная ветка ALERT_MATCH_SQL сравнивает его с зонами
 * предупреждения. Перепись охвата (проба 971) нашла острова Беринга с
 * районом «Авачинский», шесть карточек с районом вне четырёх тревожных зон и
 * 22 места без района.
 *
 * Сторож судит то, что исполнится: значения из операторов миграции (без
 * комментариев), рамку — против той же константы, по которой тревоги
 * находят Командоры, подпись — рендером карточки.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PlaceFacts from '@/components/places/PlaceFacts';
import type { PlaceSafety } from '@/components/places/types';
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { COMMANDER_BOX } from '@/lib/safety/krai-far';
import { placeZoneLabel } from '@/lib/places/zone-labels';
import { migrationBody, migrationStatements, splitTop, valueOf } from '../helpers/migration-sql';

const SQL = readFileSync(join(process.cwd(), 'migrations/1293_place_zone_by_district.sql'), 'utf-8');
const STATEMENTS = migrationStatements(migrationBody(SQL));

/**
 * Кортежи VALUES оператора: каждый — список значений. Хвостовые комментарии
 * строк («-- Старт маршрута Вачкажец (лыжный)») отрезаются: скобки в них —
 * не кортежи.
 */
function tuples(stmt: string): Array<Array<string | null>> {
  const inner = stmt.split(/FROM \(VALUES/)[1].split(/\)\s*AS v\(/)[0]
    .split('\n').map((l) => l.replace(/\s--.*$/, '')).join('\n');
  return [...inner.matchAll(/\(([^()]*)\)/g)].map((m) => splitTop(m[1]).map(valueOf));
}

const COMMANDER = STATEMENTS.find((s) => /SET zone = 'commander'/.test(s))!;
const ODD = STATEMENTS.find((s) => /AS v\(id, zone_from, zone_to\)/.test(s))!;
const NULLS = STATEMENTS.find((s) => /AS v\(id, zone_to\)/.test(s))!;
const LRS = STATEMENTS.find((s) => /INSERT INTO location_real_time_status/.test(s))!;

/** Район, который тревога находит: четыре зоны или Командоры по координате. */
const REACHABLE = new Set<string>([...ALERT_ZONES, 'commander']);

const SAFETY_EMPTY = {
  source: 'manual', difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
  terrainType: null, nearestMedicalKm: null, emergencyAccess: null,
  phoneRangerMches: null, satCommunicatorRequired: null, rulesRequired: null, weatherThreshold: null,
  hazardTypes: [], capacityPerDay: null, capacityPerDaySource: null, optimalGroupSize: null,
  openFromDate: null, openToDate: null, requiredGear: [], connectivity: null, registrationRequired: false,
  medicalInfo: null,
} as unknown as PlaceSafety;

afterEach(cleanup);

describe('Командоры', () => {
  it('рамка правки — та же, по которой тревоги находят острова', () => {
    const m = COMMANDER.match(/lat::float8 BETWEEN ([\d.]+) AND ([\d.]+)\s+AND lng::float8 BETWEEN ([\d.]+) AND ([\d.]+)/);
    expect(m, 'в правке нет рамки по координате').not.toBeNull();
    expect(m!.slice(1).map(Number)).toEqual([COMMANDER_BOX.minLat, COMMANDER_BOX.maxLat, COMMANDER_BOX.minLng, COMMANDER_BOX.maxLng]);
  });

  it('девять точек острова Беринга; меняется только «Авачинский» или пустота', () => {
    const ids = [...COMMANDER.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(9);
    expect(COMMANDER).toMatch(/AND \(zone IS NULL OR zone = 'avachinsky'\)/);
  });

  it('карточка называет острова, а не «Авачинский»', () => {
    render(<PlaceFacts locationType="settlement" zone="commander" safety={SAFETY_EMPTY} terrainType={null} />);
    expect(document.body.textContent).toMatch(/РайонКомандорские о-ва/);
    expect(document.body.textContent).not.toMatch(/Авачинск/);
  });
});

describe('район вне тревожных зон и без района', () => {
  it('каждая записанная зона — та, которую тревога находит', () => {
    const written = [...tuples(ODD).map((t) => t[2]), ...tuples(NULLS).map((t) => t[1])];
    expect(written).toHaveLength(6 + 17);
    for (const z of written) expect(REACHABLE.has(z ?? ''), `зона ${z}`).toBe(true);
  });

  it('прежнее значение — условие правки: выправленное рукой не трогается', () => {
    for (const t of tuples(ODD)) expect(REACHABLE.has(t[1] ?? ''), `прежняя зона ${t[1]} не тревожная`).toBe(false);
    expect(ODD).toMatch(/AND p\.zone = v\.zone_from/);
    expect(NULLS).toMatch(/AND p\.zone IS NULL/);
  });

  it('ни одно место не правится дважды', () => {
    const ids = [...tuples(ODD), ...tuples(NULLS)].map((t) => t[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const commander = [...COMMANDER.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
    for (const id of commander) expect(ids).not.toContain(id);
  });

  it('Корякский заповедник и точки в воде остаются без района — их нет в правке', () => {
    for (const id of [
      'b9c4e312-6d8f-4a5b-9c71-3e2f1d0b7a46', // Корякский заповедник: дальний округ, по координате
      'ef504046-2c40-438a-ad75-bb59fca5a52f', // Кекур Чёртов палец: точка в воде
      '9545339a-8dd2-44a1-9439-4bc150162dc1', // Кенотаф крейсера «Ниитака»: точка в воде
      '87028371-cf6b-9b01-47f9-6f568b8d856b', // стоянка «Столик»: округ не получен (429)
    ]) expect(migrationBody(SQL)).not.toContain(id);
  });
});

describe('подпись зоны — словами, и правдивыми', () => {
  it('западная и восточная — «Камчатка», не «побережье»: Эссо не на берегу', () => {
    expect(placeZoneLabel('western')).toBe('Западная Камчатка');
    expect(placeZoneLabel('eastern')).toBe('Восточная Камчатка');
    render(<PlaceFacts locationType="hot_spring" zone="western" safety={SAFETY_EMPTY} terrainType={null} />);
    expect(document.body.textContent).toMatch(/РайонЗападная Камчатка/);
    expect(document.body.textContent).not.toMatch(/побережье/);
  });
});

describe('строки реалтайма', () => {
  it('новая строка — «не знаем»: NULL, а не умолчания TRUE и green', () => {
    expect(LRS).toMatch(/\(agent_route_id, is_open, recommender_status\)/);
    expect(LRS).toMatch(/SELECT p\.ark_id, NULL, NULL/);
    expect(LRS).not.toMatch(/'green'|TRUE,/);
  });

  it('только видимые, не слитые, у кого строки ещё нет; повтор — без ошибки', () => {
    expect(LRS).toMatch(/p\.is_visible = TRUE/);
    expect(LRS).toMatch(/p\.merged_into_id IS NULL/);
    expect(LRS).toMatch(/NOT EXISTS \(SELECT 1 FROM location_real_time_status s WHERE s\.agent_route_id = p\.ark_id\)/);
    expect(LRS).toMatch(/ON CONFLICT \(agent_route_id\) DO NOTHING/);
  });
});
