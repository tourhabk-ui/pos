/**
 * «Точка пути» и «рядом» — разные вещи, и платформа обязана их различать.
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Миграция 167 заводила связи как «места в 15 км от ЦЕНТРА маршрута», чтобы
 * карточка места показывала маршруты поблизости. Платформа читала те же
 * связи как «маршрут здесь проходит».
 *
 * Цена: у «Скал Три Брата» среди двадцати трёх «путевых точек» краевой музей,
 * Вулканариум, памятник Берингу и батарея Максутова; у похода к Авачинскому —
 * Музей лосося и Халактырский пляж; у двух авачинских маршрутов набор точек
 * совпадает до единой. Черта при этом отказывалась вести со словами «точка
 * стоит в 10 км» — верный отказ по неверной причине.
 *
 * ── Что стережётся ────────────────────────────────────────────────────────
 *
 * 1. Связь рода «рядом» НЕ участвует в суждении о пути: ни считается, ни
 *    опровергает линию.
 * 2. Неразмеченная связь ведёт себя как раньше — иначе появление колонки
 *    улучшило бы показатели молча, то есть сменило бы линейку вместо починки.
 * 3. Карточка не рисует ломаную по местам «рядом» и не показывает их
 *    нумерованным списком этапов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asLinkKind, isPathPoint } from '@/lib/routes/link-kind';
import { routeNavigability } from '@/lib/routes/navigability';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Прямая линия — по ней и меряется отход. */
const line: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [
  53.2 + i * 0.002,
  158.4,
]);

describe('род связи', () => {
  it('незнакомое значение честно становится «не установлено»', () => {
    expect(asLinkKind('waypoint')).toBe('waypoint');
    expect(asLinkKind('nearby')).toBe('nearby');
    expect(asLinkKind(null)).toBe('unknown');
    expect(asLinkKind('лишь бы что')).toBe('unknown');
  });

  it('путём считается всё, кроме «рядом»', () => {
    expect(isPathPoint('waypoint')).toBe(true);
    expect(isPathPoint('unknown')).toBe(true);
    expect(isPathPoint('nearby')).toBe(false);
  });
});

describe('черта не судит маршрут по местам «рядом»', () => {
  it('смотровая в стороне от тропы больше не считается расхождением', () => {
    const args = {
      grade: 'surveyed' as const,
      track: line,
      waypoints: [
        { lat: 53.21, lng: 158.4 },   // на линии
        { lat: 53.24, lng: 158.4 },   // на линии
        { lat: 53.25, lng: 158.9 },   // смотровая в стороне
      ],
      // Точечный род: у протяжённого объекта расстояние и так не судят, и
      // случай был бы не про род связи.
      waypointTypes: ['hot_spring', 'hot_spring', 'viewpoint'],
    };

    // Пока связь не размечена — прежнее поведение, отказ по расстоянию.
    const before = routeNavigability(args);
    expect(before.reasons.some(r => r.includes('км от линии'))).toBe(true);

    // Размечена как «рядом» — маршрут судится по своим двум точкам пути.
    const after = routeNavigability({
      ...args,
      waypointKinds: ['waypoint', 'waypoint', 'nearby'],
    });
    expect(after.verdict).toBe('navigable');
    expect(after.conflict).toBeUndefined();
  });

  it('«рядом» не заменяет собой точки пути', () => {
    // Соблазн: разметить всё далёкое как «рядом» и получить пригодный
    // маршрут. Так нельзя — линию должно поверять хоть что-то.
    const nav = routeNavigability({
      grade: 'surveyed',
      track: line,
      waypoints: [{ lat: 53.25, lng: 158.9 }, { lat: 53.26, lng: 158.95 }],
      waypointTypes: ['museum', 'beach'],
      waypointKinds: ['nearby', 'nearby'],
    });
    expect(nav.canLead).toBe(false);
    expect(nav.reasons.join(' ')).toContain('путевых точек меньше двух');
  });

  it('подборкой мест маршрут объявляется по точкам ПУТИ, а не по округе', () => {
    // Места «рядом» разбросаны по краю по своей природе — считать их
    // разбросанность признаком «это не маршрут» значит наказывать маршрут
    // за то, что вокруг него есть достопримечательности.
    const nav = routeNavigability({
      grade: 'surveyed',
      track: null,
      waypoints: [
        { lat: 53.2, lng: 158.4 },
        { lat: 53.21, lng: 158.41 },
        { lat: 56.0, lng: 160.0 },
      ],
      waypointKinds: ['waypoint', 'waypoint', 'nearby'],
    });
    expect(nav.verdict).not.toBe('not_a_route');
  });
});

describe('карточка маршрута', () => {
  const CARD = read('app/routes/[id]/_RouteDetailClient.tsx');

  it('нумерованным списком этапов идут только точки пути', () => {
    expect(CARD).toMatch(/\{pathWaypoints\.map\(/);
    expect(
      /route\.waypoints!\.map\(/.test(CARD),
      'список этапов снова строится по ВСЕМ связям — музей вернётся в маршрут',
    ).toBe(false);
  });

  it('места «рядом» показаны отдельно и названы своим именем', () => {
    expect(CARD).toContain('Рядом с маршрутом');
    expect(CARD).toMatch(/nearbyWaypoints\.map\(/);
  });

  it('ломаная на карте строится только по точкам пути', () => {
    // Линия через Музей лосося и Халактырский пляж на карте неотличима от
    // тропы — а по ней пойдут.
    const nav = CARD.slice(CARD.indexOf('const navWaypoints'), CARD.indexOf('const usingServerTrack'));
    expect(nav).toContain('pathWaypoints');
    expect(nav).not.toMatch(/route\.waypoints/);
  });
});

describe('полевой контур не ведёт по местам «рядом»', () => {
  const FIELD = read('app/planning/_PlanningClient.tsx');

  it('точки хода фильтруются по роду связи до конвертации', () => {
    // Поле, 20.08: у Скал Три Брата краевой музей и батарея Максутова
    // числились этапами, и ход честно считал по ним 142 км ломаной на
    // прогулку в пару километров. Плечи, прогресс и компас строятся из
    // waypoints — значит фильтр обязан стоять на входе, при конвертации.
    expect(FIELD).toContain(".filter(w => w.linkKind !== 'nearby')");
  });
});

describe('разметка идёт по улике, а не по расстоянию', () => {
  const MIG = read('migrations/874_route_waypoints_link_kind.sql');

  it('точки пути берутся из явных пар миграций 653-657', () => {
    // 238 связей, перечисленных поимённо в самих файлах миграций.
    const pairs = MIG.match(/\('[0-9a-f-]{36}','[0-9a-f-]{36}'\)/g) ?? [];
    expect(pairs.length).toBe(238);
  });

  it('«рядом» определяется предикатом 167, а не близостью к линии', () => {
    // Если бы род связи выводился из расстояния до линии, любой маршрут
    // проходил бы черту: всё неудобное переименовалось бы в «рядом». Это
    // выключение сигнализации, а не починка данных.
    expect(MIG).toContain('<= 15');
    expect(MIG).toContain('kamchatka_routes r');
    expect(MIG).not.toMatch(/geometry/);
  });

  it('остаток остаётся неустановленным', () => {
    expect(MIG).toContain("DEFAULT 'unknown'");
  });
});
