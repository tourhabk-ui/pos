/**
 * Сторож правила старшинства линии маршрута (замер 07.09, «го» владельца).
 *
 * ── Что было ───────────────────────────────────────────────────────────────
 *
 * Линию в `kamchatka_routes.geometry` кладут семь схем, и правило «что кому
 * можно переписать» было скопировано в каждую руками. Девять копий, и они
 * разошлись:
 *
 *   osm-import-runner     NULL или 'waypoints_synthetic'
 *   idilesom-importer     NULL или 'idilesom'  ← слог мёртв после миграции 871
 *   kml-inbox             NULL, 'kml_inbox', 'waypoints_synthetic'
 *   route-lay             только NULL
 *   visitkamchatka-gpx    УСЛОВИЯ НЕТ — затирал что угодно
 *   track-import-queue    УСЛОВИЯ НЕТ + свой WEAK_SOURCES
 *   route-family-merge    свой перечень в SQL
 *
 * Два последних молча перекрывали снятый трек: чей прогон случился позже,
 * того и линия. На карте это не мелочь — §12: по линии человек идёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  mayOverwrite, overwritableSources, normalizeGeometrySource,
  GEOMETRY_RANK, overwriteWhereSql,
} from '@/lib/routes/geometry-precedence';

describe('сила источника — мера подтверждения, а не вкус', () => {
  it('снятый прибором путь сильнее всего остального', () => {
    for (const weaker of ['osm', 'kml_inbox', 'visitkamchatka', 'external', 'road_graph_astar', 'waypoints_synthetic'] as const) {
      expect(GEOMETRY_RANK.gpx, weaker).toBeGreaterThan(GEOMETRY_RANK[weaker]);
      expect(GEOMETRY_RANK.field_track, weaker).toBeGreaterThan(GEOMETRY_RANK[weaker]);
    }
  });

  it('прямые между точками слабее всего: их форма заведомо ложная', () => {
    for (const stronger of Object.keys(GEOMETRY_RANK)) {
      if (stronger === 'waypoints_synthetic') continue;
      expect(GEOMETRY_RANK[stronger as keyof typeof GEOMETRY_RANK], stronger)
        .toBeGreaterThan(GEOMETRY_RANK.waypoints_synthetic);
    }
  });

  it('построение по графу слабее скрейпа: путь по нему никто не проходил', () => {
    expect(GEOMETRY_RANK.road_graph_astar).toBeLessThan(GEOMETRY_RANK.external);
  });
});

describe('решение о перезаписи', () => {
  it('в пустоту кладут все', () => {
    expect(mayOverwrite(null, 'road_graph_astar').allowed).toBe(true);
    expect(mayOverwrite('', 'waypoints_synthetic').allowed).toBe(true);
  });

  it('слабый не перекрывает сильного', () => {
    expect(mayOverwrite('gpx', 'external').allowed).toBe(false);
    expect(mayOverwrite('osm', 'road_graph_astar').allowed).toBe(false);
    expect(mayOverwrite('external', 'waypoints_synthetic').allowed).toBe(false);
  });

  it('сильный перекрывает слабого', () => {
    expect(mayOverwrite('waypoints_synthetic', 'osm').allowed).toBe(true);
    expect(mayOverwrite('external', 'gpx').allowed).toBe(true);
  });

  it('свой обновляет своё', () => {
    expect(mayOverwrite('osm', 'osm').allowed).toBe(true);
    // Прежний слог скрейпа — тот же источник: миграция 871 переименовала его
    // в базе, но в полевых пакетах на телефонах он остался навсегда.
    expect(mayOverwrite('idilesom', 'external').allowed).toBe(true);
    expect(normalizeGeometrySource('idilesom')).toBe('external');
  });

  it('НЕИЗВЕСТНЫЙ слог не считается слабым', () => {
    // Третье состояние (§4.0): не знаем, чем подтверждена линия, — значит
    // не имеем права её уничтожить. Слабым «по умолчанию» её объявить
    // означало бы стирать чужую работу молча.
    const d = mayOverwrite('нечто-новое', 'gpx');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('неизвестен');
  });

  it('у решения всегда есть причина словами', () => {
    for (const [from, to] of [[null, 'osm'], ['gpx', 'external'], ['osm', 'osm']] as const) {
      expect(mayOverwrite(from, to as never).reason.length).toBeGreaterThan(3);
    }
  });
});

describe('условие для запроса собирается правилом, а не руками', () => {
  it('перечень для перезаписи — слабее себя плюс свой слог', () => {
    const forOsm = overwritableSources('osm');
    expect(forOsm).toContain('osm');
    expect(forOsm).toContain('waypoints_synthetic');
    expect(forOsm).toContain('external');
    expect(forOsm).not.toContain('gpx');
  });

  it('прежний слог попадает в перечень вместе с нынешним', () => {
    expect(overwritableSources('external')).toContain('idilesom');
  });

  it('условие идёт параметром, а не склейкой строк', () => {
    expect(overwriteWhereSql(4)).toContain('$4::text[]');
    expect(overwriteWhereSql(2, 'kr.geometry')).toContain('kr.geometry IS NULL');
  });
});

describe('копий правила в писателях больше нет', () => {
  // Ищем ручные условия «NULL или такой-то слог» в обход общего правила.
  // Именно так девять копий и разошлись; десятая разойдётся так же.
  const ROOTS = ['lib', 'app', 'scripts'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx)$/.test(full)) files.push(full);
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));

  const ALLOWED = ['lib/routes/geometry-precedence.ts'];

  it('никто не сравнивает geometry->>\'source\' со своим списком слогов', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(process.cwd().length + 1);
      if (ALLOWED.some(a => rel.endsWith(a))) continue;
      const src = readFileSync(f, 'utf8');
      // Судим ФОРМУ отбора для перезаписи — «линии нет ИЛИ слог такой-то».
      // Счётчик (COUNT ... FILTER) и сортировка (ORDER BY) сравнивают слог по
      // делу и ничего не затирают: ловить их значит наказывать за замер.
      if (/geometry\s+IS\s+NULL\s+OR\s+[\w.]*geometry->>'source'\s*(=\s*'|IN\s*\()/i.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `своё условие вместо общего правила (lib/routes/geometry-precedence): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
