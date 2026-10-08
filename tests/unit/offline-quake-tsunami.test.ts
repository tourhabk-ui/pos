/**
 * Офлайн-памятка: сильное землетрясение и цунами (08.10).
 *
 * Вопрос владельца со ссылками на памятки КФ ФИЦ ЕГС РАН: «у нас есть эти
 * инструкции?» — не было. Памятка /safety/offline знала медведя, вулкан,
 * гипотермию, «потерялся», сигналы и воду; о землетрясении было три строки в
 * промпте чата спасателя, о цунами — одна фраза в пуше. Для Камчатки, где
 * волна 1952 года шла на Халактырку через 18–42 минуты, это дыра.
 *
 * Сторож держит:
 * 1. оба раздела есть, рядом с вулканом, и работают без сети (страница
 *    статическая — ни fetch, ни базы);
 * 2. числа памяток не потеряны при пересказе: 15–20 секунд, 30–40 м и 5 м,
 *    15–20 минут, 2–3 км, 3 часа, долины рек, 50 м глубины для лодки;
 * 3. у каждого раздела — ссылка на памятку, по которой он написан.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(process.cwd(), 'app/safety/offline/page.tsx'), 'utf-8');

function section(id: string): string {
  const at = PAGE.indexOf(`id: '${id}'`);
  expect(at, `раздела ${id} нет`).toBeGreaterThan(0);
  const end = PAGE.indexOf('\n  },', at);
  return PAGE.slice(at, end);
}

describe('1. разделы есть и работают без сети', () => {
  it('землетрясение и цунами — после вулкана, до гипотермии', () => {
    const order = ['volcano', 'earthquake', 'tsunami', 'hypothermia'].map((id) => PAGE.indexOf(`id: '${id}'`));
    expect(order.every((v) => v > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('страница по-прежнему статическая: без fetch и базы', () => {
    expect(PAGE).not.toMatch(/\bfetch\(|from '@\/lib\/db-pool'|force-dynamic/);
  });

  it('цунами — цветом опасности, без эмодзи и хардкода цвета', () => {
    expect(section('tsunami')).toMatch(/color: 'var\(--danger\)'/);
    expect(PAGE).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(PAGE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('2. числа памяток не потеряны', () => {
  it('землетрясение: 15–20 секунд, проём капитальной стены, лифт, повторные толчки 2–3 часа, сигнал цунами', () => {
    const s = section('earthquake');
    for (const must of ['15–20 секунд', 'капитальной внутренней стены', 'лифтом', '2–3 часа', 'сигнал цунами']) {
      expect(s, must).toContain(must);
    }
  });

  it('цунами: 30–40 м и 5 м, 15–20 минут, долины рек, 2–3 км, 3 часа, 50 м для лодки', () => {
    const s = section('tsunami');
    // Высота дважды: где опасно и куда уходить — проверяется каждое место, а
    // не одно число на весь раздел (мутация «вверх на 10 м» прошла бы).
    for (const must of ['ниже 30–40 м над морем', 'вверх по склону на 30–40 м над морем', 'не ниже 5 м', '15–20 минут', 'долинами рек', '2–3 км', '3 часа', 'больше 50 м', 'Не спускайся к воде']) {
      expect(s, must).toContain(must);
    }
  });
});

describe('3. у каждого раздела — источник', () => {
  it('ссылки на обе памятки КФ ФИЦ ЕГС РАН', () => {
    expect(section('earthquake')).toContain("href: 'https://emsd.ru/library/silnye-zemletryaseniya-pamyatka'");
    expect(section('tsunami')).toContain("href: 'https://emsd.ru/library/tsunami-pamyatka-naseleniyu'");
  });

  it('источник выводится под разделом, а не только лежит в данных', () => {
    expect(PAGE).toMatch(/\{section\.source && \(/);
    expect(PAGE).toMatch(/href=\{section\.source\.href\}/);
  });
});
