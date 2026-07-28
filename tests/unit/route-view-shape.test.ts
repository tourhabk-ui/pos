/**
 * Код не должен просить у представления колонки, которых в нём нет.
 *
 * Живое `v_kamchatka_routes_api` на проде (аудит 28.07) состоит из:
 *   route_id, route_dedupe_key, category, title, description, lat, lng,
 *   source_url, source_name, import_source, has_coordinates, category_total,
 *   category_position, metadata, created_at, source_updated_at
 *
 * В файлах репозитория представление описано иначе — с `id`, `mchs_phone`,
 * `geometry`, `is_visible` и прочим. Расхождение живёт давно: миграции 670 и
 * 738, которые привели бы прод к виду из файлов, не применялись НИ РАЗУ
 * (670 — «cannot change name of view column route_id to id», 738 — «other
 * objects depend on it»; зависимый объект — v_kamchatka_route_groups_api).
 *
 * Цена расхождения оказалась не теоретической: `computeRescueCoverage`
 * (покрытие маршрутов телефонами МЧС) и `checkRouteOfflineReadiness`
 * (готовность офлайн-пакета) спрашивали `id`, `mchs_phone`, `geometry` — то
 * есть падали при каждом вызове. Обе функции — safety-путь: первая отвечает на
 * вопрос «есть ли у туриста способ связаться со спасателями заранее», вторая —
 * «переживёт ли маршрут потерю связи».
 *
 * Пока представление не починено, сторож держит границу: из
 * `v_kamchatka_routes_api` спрашиваются только те колонки, которые в нём есть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

/** Колонки живого представления — снято аудитом боевой схемы 28.07. */
const LIVE_VIEW_COLUMNS = new Set([
  'route_id', 'route_dedupe_key', 'category', 'title', 'description',
  'lat', 'lng', 'source_url', 'source_name', 'import_source',
  'has_coordinates', 'category_total', 'category_position', 'metadata',
  'created_at', 'source_updated_at',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...walk('app'), ...walk('lib')].map((path) => ({
  path,
  src: readFileSync(join(ROOT, path), 'utf-8'),
}));

/** SQL-строки (шаблонные литералы), которые читают представление. */
function viewQueries(src: string): string[] {
  return src
    .split('`')
    .filter((chunk) => /\bfrom\s+v_kamchatka_routes_api\b/i.test(chunk));
}

describe('запросы к v_kamchatka_routes_api совпадают с его формой', () => {
  it('запрошенные колонки существуют в живом представлении', () => {
    const offenders: string[] = [];

    for (const { path, src } of SOURCES) {
      for (const q of viewQueries(src)) {
        const select = /select\s+([\s\S]*?)\s+from\s+v_kamchatka_routes_api/i.exec(q)?.[1];
        if (!select || select.trim() === '*') continue;
        for (const raw of select.split(',')) {
          const col = raw.trim().split(/\s+/)[0].replace(/^\w+\./, '');
          if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue;
          if (!LIVE_VIEW_COLUMNS.has(col.toLowerCase())) {
            offenders.push(`${path}: ${col}`);
          }
        }
      }
    }

    expect(
      offenders,
      'такой колонки в живом представлении нет — читай kamchatka_routes с фильтром is_visible либо сначала почини вьюху (миграции 670/738)',
    ).toEqual([]);
  });

  it('safety-функции больше не ходят в представление', () => {
    // Именно они падали на проде. Проверка отдельная: даже если однажды кто-то
    // добавит во вьюху нужные колонки, возвращать туда safety-путь стоит
    // осознанно, а не случайно.
    for (const file of ['lib/services/safety/rescue-coverage.ts', 'lib/services/offline-readiness.ts']) {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, `${file} снова читает представление`).not.toContain('FROM v_kamchatka_routes_api');
    }
  });

  it('фильтр видимости при чтении мастер-таблицы не потерян', () => {
    // Правило CLAUDE.md про представление существует ради того, чтобы наружу не
    // попадали скрытые маршруты. Читаем мастер — обязаны фильтровать сами.
    for (const file of ['lib/services/safety/rescue-coverage.ts', 'lib/services/offline-readiness.ts']) {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      expect(src, `${file}: нет фильтра is_visible`).toMatch(/is_visible\s*=\s*TRUE/i);
    }
  });
});
