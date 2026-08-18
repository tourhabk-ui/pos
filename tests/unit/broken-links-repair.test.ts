/**
 * Уборка снимает ЛОЖЬ, а не данные.
 *
 * Решение владельца 18.08: «убираем эти битые данные». Определить, что именно
 * битое, важнее самой уборки — ночью выяснилось, что 277 линий из 301
 * доказаны как записи прибора, и выбросить их значило бы выбросить
 * единственное настоящее, что у платформы есть.
 *
 * Битой считается СВЯЗЬ маршрута с точкой, опровергнутая собственным треком:
 * запись утверждает «маршрут проходит здесь», а доказанный трек там не
 * проходит. Это та самая ложь, которую владелец увидел в поле на Козельском —
 * «до следующей точки 14 км», стоя на тропе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brokenLinks, safeToRepair, MAX_LINKS_PER_ROUTE } from '@/lib/routes/broken-links';
import { DATA_CONFLICT_KM } from '@/lib/on-route/approach';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SRC = read('lib/routes/broken-links.ts');
const API = read('app/api/cron/route-links-repair/route.ts');
const WORKFLOW = read('.github/workflows/route-links-repair.yml');
const TRIGGER = read('.github/triggers/route-links-repair.json');

/** Короткая тропа под Петропавловском. */
const TRACK = Array.from({ length: 30 }, (_, i) => ({ lat: 53.02 + i * 0.0005, lng: 158.65 + i * 0.0005 }));
const onTrack = { placeId: 'p1', placeTitle: 'Перевал', lat: 53.0285, lng: 158.6585 };
const farAway = { placeId: 'p2', placeTitle: 'Мыс Маячный', lat: 53.15, lng: 158.65 };

describe('опровергнутая привязка находится', () => {
  it('точка дальше порога от доказанной линии', () => {
    const found = brokenLinks({
      routeId: 'r1', routeTitle: 'Вулкан Козельский',
      track: TRACK, lineProven: true, waypoints: [onTrack, farAway],
    });
    expect(found).toHaveLength(1);
    expect(found[0].placeTitle).toBe('Мыс Маячный');
    expect(found[0].offTrackKm).toBeGreaterThan(DATA_CONFLICT_KM);
  });

  it('точка на линии не трогается', () => {
    const found = brokenLinks({
      routeId: 'r1', routeTitle: 'Тропа', track: TRACK, lineProven: true, waypoints: [onTrack],
    });
    expect(found).toEqual([]);
  });
});

describe('недоказанная линия никого не обвиняет', () => {
  it('без улики расхождение не значит, кто именно врёт', () => {
    // Если линия — скрейп неизвестного происхождения, виноватой может быть
    // она, и удаление точки закрепило бы ошибку.
    const found = brokenLinks({
      routeId: 'r1', routeTitle: 'Тропа', track: TRACK, lineProven: false, waypoints: [farAway],
    });
    expect(found).toEqual([]);
  });

  it('линии нет — сверять нечем', () => {
    const found = brokenLinks({
      routeId: 'r1', routeTitle: 'Тропа', track: [], lineProven: true, waypoints: [farAway],
    });
    expect(found).toEqual([]);
  });

  it('порог общий с полевым экраном и чертой', () => {
    // Свой порог означал бы, что «расхождение» при уборке и «расхождение» при
    // отказе вести — разные величины.
    expect(SRC).toMatch(/DATA_CONFLICT_KM/);
    expect(SRC).not.toMatch(/offTrackKm > \d/);
  });
});

describe('маршрут, противоречащий себе целиком, чинит человек', () => {
  it('опровергнуты все точки — не наш случай', () => {
    // Дело уже не в отдельной привязке: перепутан маршрут или линия чужая.
    expect(safeToRepair(2, 2)).toBe(false);
  });

  it('опровергнуто слишком много — тоже', () => {
    expect(safeToRepair(MAX_LINKS_PER_ROUTE + 1, 99)).toBe(false);
  });

  it('одна-две лишние точки из многих — чиним', () => {
    expect(safeToRepair(1, 5)).toBe(true);
    expect(safeToRepair(2, 8)).toBe(true);
  });

  it('чинить нечего — не повод что-то делать', () => {
    expect(safeToRepair(0, 5)).toBe(false);
  });
});

describe('уборка не может случиться заодно', () => {
  it('умолчание — сухой прогон, писать разрешает только явное dry_run=false', () => {
    // Цена ошибки несимметрична: удаление данных, от которых зависит
    // безопасность, не должно случаться от опечатки в параметре.
    expect(API).toMatch(/dry_run'\) !== 'false'/);
    expect(TRIGGER).toMatch(/"dry_run": true/);
    expect(WORKFLOW).toMatch(/dry_run/);
  });

  it('удаляется ТОЛЬКО связь — ни место, ни маршрут, ни линия', () => {
    expect(API).toMatch(/DELETE FROM route_waypoints/);
    expect(API).not.toMatch(/DELETE FROM places/);
    expect(API).not.toMatch(/DELETE FROM kamchatka_routes/);
    expect(API).not.toMatch(/UPDATE kamchatka_routes SET geometry/);
  });

  it('версия маршрута растёт — полевые пакеты узнают об изменении', () => {
    // Снимок на телефоне хранит состав точек; без инкремента он остался бы с
    // прежним и вёл бы к снятой точке офлайн.
    expect(API).toMatch(/route_version = COALESCE\(route_version, 1\) \+ 1/);
  });

  it('случаи для человека печатаются, а не пропускаются молча', () => {
    expect(API).toMatch(/needs_human/);
    expect(WORKFLOW).toMatch(/случаев для человека/);
  });

  it('прогон ждёт СВОЙ код на проде', () => {
    // Первый прогон 18.08 07:02 упал с 404: мерж прошёл минутой раньше, а
    // сборка Timeweb идёт десять минут. Тот же дефект уже чинили в переписи
    // двумя часами ранее — и не перенесли сюда.
    expect(API).toMatch(/REPAIR_VERSION/);
    const unauth = API.slice(API.indexOf('Unauthorized') - 120, API.indexOf('Unauthorized') + 80);
    expect(unauth).toMatch(/v: REPAIR_VERSION/);
    expect(WORKFLOW).toMatch(/прод отдаёт уборку версии/);
    expect(WORKFLOW).toMatch(/Прогон без своего кода — не ответ/);
  });

  it('видно поимённо, что именно снимается', () => {
    // «Снято 33» без имён не даёт проверить решение.
    expect(WORKFLOW).toMatch(/что именно снимается/);
    expect(API).toMatch(/samples/);
  });
});
