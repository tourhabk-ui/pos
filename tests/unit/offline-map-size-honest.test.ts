/**
 * Обещанный вес карты — настоящий, и ноль на кнопке не появляется.
 *
 * Полевой скриншот владельца 10.08, экран «На маршруте»:
 * «Сохранить карту · 0 МБ».
 *
 * Ноль здесь не описка, а ошибка в опасную сторону. План строится двумя
 * путями: коридором вдоль трека и — если трека нет — квадратом вокруг точки.
 * На втором пути сервер отдавал `estimate_mb: null`, клиент превращал его в
 * ноль (`Number(null) || 0`), и кнопка обещала скачать ничего. За ней стоял
 * квадрат, срезанный по 2000 тайлов, — порядка сорока мегабайт мобильного
 * трафика. Человек в поле читает «0 МБ» как «бесплатно» и жмёт.
 *
 * Тот же класс, что весь день: отсутствующее значение показано как уверенная
 * цифра.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTilesMb } from '@/lib/offline/route-corridor';

const tiles = (z: number, n: number) =>
  Array.from({ length: n }, (_, i) => `https://tile.example/${z}/${100 + i}/200.png`);

describe('вес считается по тому же списку тайлов, что и отдаётся', () => {
  it('пустой список — ноль, и это единственный законный ноль', () => {
    expect(estimateTilesMb([])).toBe(0);
  });

  it('непустой список никогда не весит ноль', () => {
    // Один тайл — это килобайты, но обещать «0 МБ» нельзя: округление вниз
    // и есть тот самый ноль, который читается как «бесплатно».
    expect(estimateTilesMb(tiles(12, 1))).toBeGreaterThanOrEqual(1);
  });

  it('срезанный по потолку квадрат весит десятки мегабайт, а не ноль', () => {
    // MAX_TILES=2000 в offline-bundle — ровно тот случай со скриншота.
    const mb = estimateTilesMb(tiles(12, 2000));
    expect(mb).toBeGreaterThan(20);
  });

  it('детальные зумы весят больше грубых', () => {
    expect(estimateTilesMb(tiles(12, 1000))).toBeGreaterThan(estimateTilesMb(tiles(15, 1000)));
  });

  it('неразобранный адрес считается по среднему, а не пропускается', () => {
    // Пропуск снова занизил бы обещание — а ошибаться здесь можно только
    // в сторону «дороже, чем сказали».
    expect(estimateTilesMb(['https://tile.example/strange-name'])).toBeGreaterThanOrEqual(1);
  });
});

describe('оба пути плана называют вес', () => {
  const API = readFileSync(
    join(process.cwd(), 'app/api/routes/[id]/offline-bundle/route.ts'), 'utf-8',
  );

  it('без коридора вес считается, а не отдаётся пустым', () => {
    expect(API).toContain('estimateTilesMb(tileUrls)');
    expect(API).not.toMatch(/estimate_mb:\s*corridor\s*\?\s*corridor\.estimateMb\s*:\s*null/);
  });
});

describe('кнопка не показывает ноль как размер', () => {
  const UI = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('число печатается только когда оно положительное', () => {
    expect(UI).toMatch(/mapPlan\.mb\s*>\s*0\s*\?/);
  });

  it('счётчик точек скрыт у маршрута из одной точки', () => {
    // «Точка 1 из 1» рядом с «до следующей точки · 18.5 км» читается как
    // «вы пришли, идти ещё 18 километров».
    //
    // Счётчик переехал в приборную строку и прогресс-модуль (дизайн-проход
    // по макетам FCN): вместо условного рендера ему передаётся `null`,
    // когда точек меньше двух. Правило то же, выражено иначе.
    expect(UI).toMatch(/checkpoint=\{waypoints\.length > 1/);
    expect(UI).toMatch(/waypoints\.length > 1[\s\S]{0,160}: null\}/);
  });

  it('подпись расстояния согласована с числом точек', () => {
    expect(UI).toContain("'до следующей точки' : 'до точки'");
  });
});
