/**
 * Списки не стримятся (аудит 02.10).
 *
 * Страница, которая ждёт `searchParams`, в Next 15 уходит потоком: в первом
 * HTML — пустая `<main>` и `<template id="B:…">`, а содержимое приезжает
 * отдельным куском, который робот без JS не собирает. На проде /operators и
 * /catalog отдавали ноль слов в `<main>`, а /articles (промиса нет) — список
 * целиком. Поэтому серверный список рендерится по умолчанию, а фильтры из
 * адреса применяет клиент после монтирования — через `window.location`, а не
 * `useSearchParams`: тот на сервере дал бы другой первый HTML, чем у страницы.
 *
 * Проверено локальной сборкой 02.10: /operators — ноль `<template>`, h1 и
 * список в первом HTML; /catalog по-прежнему стримит ОДНУ границу — скелет
 * `loading.tsx` группы (list) (navigation-loading). Он оставлен намеренно:
 * снимать его ради роботов без JS — решение владельца.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LIST_PAGES = ['app/operators/page.tsx', 'app/catalog/(list)/page.tsx', 'app/marketplace/page.tsx'];
const LIST_CLIENTS = ['app/marketplace/operators/_OperatorsClient.tsx', 'components/marketplace/MarketplaceClient.tsx'];

describe('страницы списков не ждут searchParams', () => {
  for (const p of LIST_PAGES) {
    it(`${p}: нет searchParams и Suspense, страница динамическая`, () => {
      const src = code(read(p));
      expect(src).not.toMatch(/searchParams/);
      expect(src).not.toMatch(/Suspense/);
      // Сборка Docker идёт без БД: статический пререндер запёк бы пустой список.
      expect(src).toMatch(/export const dynamic = 'force-dynamic'/);
    });
  }
});

describe('клиенты списков читают адрес после монтирования', () => {
  for (const p of LIST_CLIENTS) {
    it(`${p}: window.location вместо useSearchParams, первый sync адреса пропущен`, () => {
      const src = code(read(p));
      expect(src).not.toMatch(/useSearchParams/);
      expect(src).toMatch(/new URLSearchParams\(window\.location\.search\)/);
      expect(src).toMatch(/urlSyncArmedRef\.current = true; return;/);
    });
  }
});
