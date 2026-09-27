/**
 * Кабинет туриста: отказ не выдаётся ни за пустоту, ни за отсутствие.
 *
 * ── Что нашлось обходом экранов 26.09 ────────────────────────────────────
 *
 * Кабинет прошли браузером под настоящей сессией туриста — все 17 экранов
 * отвечают 200. Разбор их роутов дал другое: третий исход §4.0 в кабинете
 * держался местами, а не правилом.
 *
 *   • восемнадцать роутов под `app/api/tourist`, `app/api/notifications` и
 *     `app/api/loyalty` глушили отказ без единой строки в лог. Ответ при этом
 *     был верный (500, а не пустой список) — то есть туристу не лгали, но
 *     ПРИЧИНУ отказа узнать было нельзя ниоткуда. Рядом, в
 *     `bookings/my` и `safety-registrations`, это уже сделано образцово;
 *   • `getTouristProfile` возвращала `null` и при отказе базы, и при
 *     отсутствии профиля, а все девять вызывающих отвечают на `null`
 *     404 «Профиль не найден». Человек с живым профилем при обрыве соединения
 *     читал, что профиля у него не существует: третий исход выдавался за
 *     второй;
 *   • `/api/tourist/stats` брал эко-баланс как `getBalance(...).catch(() => 0)`
 *     — ноль законен для пустого счёта, но тем же нулём накрывался настоящий
 *     отказ базы, и человек с баллами видел «0 эко»;
 *   • «Обзор» кабинета при отказе сводки просто УБИРАЛ четыре карточки KPI.
 *     Пропавший блок читается как «поездок ноль», и это ровно та подмена,
 *     против которой на соседнем экране «Моя Камчатка» уже стоит прочерк.
 *
 * Сторож держит правило по КАТАЛОГАМ, а не по списку файлов: новый роут
 * кабинета, проглотивший отказ молча, краснеет сам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const CABINET_API_DIRS = ['app/api/tourist', 'app/api/notifications', 'app/api/loyalty'];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

const ROUTES = CABINET_API_DIRS.flatMap((d) => routeFiles(join(ROOT, d))).map((path) => ({
  rel: path.replace(ROOT + '/', ''),
  lines: readFileSync(path, 'utf-8').split('\n'),
}));

describe('роуты кабинета не глушат отказ', () => {
  it('роуты найдены (пустой обход — отказ, а не успех)', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(15);
  });

  for (const { rel, lines } of ROUTES) {
    it(`${rel}: у каждого catch есть причина в логе`, () => {
      const silent: string[] = [];
      lines.forEach((line, i) => {
        // Блочный catch, а не `.catch(() => ...)`: у второго своё назначение
        // (разбор тела запроса, необязательные шаги) и свои правила.
        if (!/\}\s*catch\s*(\(\s*\w+\s*\))?\s*\{\s*$/.test(line.trim())) return;
        // Окно с запасом: перед логом часто стоит объяснение причины
        // комментарием — это не повод считать отказ проглоченным.
        const window = lines.slice(i + 1, i + 12).join('\n');
        const logs = /console\.(error|warn)/.test(window);
        const namesSqlstate = /sqlstate/i.test(window);
        if (!logs || !namesSqlstate) silent.push(`${i + 1}: ${line.trim()}`);
      });
      expect(
        silent,
        `${rel}: отказ проглочен без причины в логе — назовите SQLSTATE (§4.0 «отказ не глушится»):\n${silent.join('\n')}`,
      ).toEqual([]);
    });
  }
});

describe('«не смог» не равно «нет»', () => {
  it('getTouristProfile при отказе базы не отвечает «профиля нет»', () => {
    const src = read('lib/auth/tourist-helpers.ts');
    const catchStart = src.indexOf('} catch', src.indexOf('export async function getTouristProfile'));
    expect(catchStart).toBeGreaterThan(0);
    const block = src.slice(catchStart, catchStart + 900);
    expect(block, 'причина отказа обязана остаться в логе').toMatch(/sqlstate/i);
    expect(
      /return null;/.test(block),
      'отказ базы возвращается как null — вызывающие ответят 404 «Профиль не найден»',
    ).toBe(false);
    expect(block, 'отказ обязан улететь выше: у вызывающих есть catch, отвечающий 500').toMatch(/throw/);
  });

  it('эко-баланс не подменяется нулём при отказе', () => {
    const src = read('app/api/tourist/stats/route.ts');
    expect(src).toMatch(/getBalance\(userId\)/);
    expect(
      /getBalance\([^)]*\)\s*\.catch\(/.test(src),
      'свой catch у getBalance накрывает и настоящий отказ базы: человек с баллами увидит 0',
    ).toBe(false);
  });

  it('«Обзор» при отказе сводки рисует прочерк, а не прячет блок', () => {
    const src = read('app/hub/tourist/_TouristDashboardClient.tsx');
    expect(src, 'нет состояния «сводку посчитать не удалось»').toMatch(/statsFailed/);
    // Прочерк вместо значения — тот же приём, что на «Моей Камчатке».
    expect(src).toMatch(/statsFailed \? \[/);
    expect(src).toMatch(/value: '—'/);
  });
});
