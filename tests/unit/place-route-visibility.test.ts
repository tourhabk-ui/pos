/**
 * Витрина показывает только живое — по обе стороны связи место↔маршрут.
 *
 * Дыра, которую стережёт этот файл, была настоящей: скрытые паутины (867,
 * 868) и слитые дубли (869) уходили из каталога маршрутов, но карточка
 * места брала их из route_waypoints без единого фильтра — турист видел в
 * блоке «Маршруты» ссылку на «маршрут» длиной 397 км, которого в каталоге
 * уже нет.
 *
 * Проверяются исходники запросов, а не выдача: до БД тест не ходит, а
 * забытый фильтр виден в SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
// Отбор маршрутов места живёт в общем модуле (03.10): его берут и карточка,
// и Кузьмич. Карточка обязана брать его оттуда, а не держать свою копию.
const placeCard = readFileSync(join(ROOT, 'lib/places/place-routes.ts'), 'utf-8');
const placeDetail = readFileSync(join(ROOT, 'lib/places/place-detail.ts'), 'utf-8');
const routeCard = readFileSync(join(ROOT, 'app/api/routes/[id]/route.ts'), 'utf-8');

describe('карточка места — блок «Маршруты»', () => {
  it('карточка берёт отбор из общего модуля, своей копии SQL нет', () => {
    expect(placeDetail).toContain('query(PLACE_ROUTES_SQL, [r.place_pk])');
    expect(placeDetail).not.toContain('FROM route_waypoints rw\n       JOIN kamchatka_routes kr ON kr.id = rw.route_id\n       WHERE rw.place_id = $1');
  });

  it('берёт только видимые и не слитые маршруты', () => {
    const start = placeCard.indexOf('FROM route_waypoints rw');
    const block = placeCard.slice(start, placeCard.indexOf('LIMIT 10', start));
    expect(block).toContain('kr.is_visible = TRUE');
    expect(block).toContain('kr.merged_into_id IS NULL');
  });

  it('отдаёт СПИСОК маршрутов: к месту их бывает несколько', () => {
    // Авачинский вулкан: дневное восхождение, ночное, через перевал.
    // Лимит существует, но он не единица — карточка не выбирает «главный».
    const limit = /LIMIT (\d+)/.exec(placeCard.slice(placeCard.indexOf('FROM route_waypoints rw')));
    expect(limit).not.toBeNull();
    expect(Number(limit![1])).toBeGreaterThan(1);
  });

  it('не сортирует маршруты по позиции точки внутри маршрута', () => {
    const start = placeCard.indexOf('FROM route_waypoints rw');
    const block = placeCard.slice(start, placeCard.indexOf('LIMIT 10', start));
    expect(block, 'position — номер точки В маршруте, для списка маршрутов он бессмыслен')
      .not.toMatch(/ORDER BY rw\.position/);
  });
});

describe('карточка маршрута — точки пути', () => {
  it('берёт только видимые и не слитые места', () => {
    const occurrences = routeCard.split('FROM route_waypoints rw').slice(1);
    expect(occurrences.length).toBeGreaterThan(0);
    for (const block of occurrences) {
      const head = block.slice(0, 600);
      expect(head).toContain('p.is_visible = TRUE');
      expect(head).toContain('p.merged_into_id IS NULL');
    }
  });
});
