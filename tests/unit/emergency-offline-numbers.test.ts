/**
 * Офлайн-страница спасения не расходится с реестром номеров.
 *
 * `public/emergency.html` — единственная страница, которая доступна, когда не
 * работает ничего остального: она лежит в precache service worker'а, не тянет
 * ни данных, ни RSC. Именно поэтому телефоны в ней вбиты руками — импортировать
 * TypeScript статический файл не может.
 *
 * Ручная копия расходится. Замер 22.08.2026: в реестре четыре федеральных
 * номера, на офлайн-странице было три — не хватало полиции (102). Разошлось
 * молча и, судя по всему, давно: заметить это можно только сверкой.
 *
 * Канон — `lib/safety/emergency-numbers.ts`. Он же кормит шесть экранов
 * приложения. Сторож держит третью копию в согласии с ним в обе стороны:
 * пропажа номера — дыра, лишний номер — непроверенный телефон в чрезвычайной
 * ситуации, а «неверный номер в ЧП опаснее его отсутствия» (решение владельца
 * при чистке региональных линий).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EMERGENCY_NUMBERS, telHref } from '@/lib/safety/emergency-numbers';

const HTML = fs.readFileSync(path.join(process.cwd(), 'public/emergency.html'), 'utf8');

/** Все `tel:` со страницы, в том виде, в каком их наберёт телефон. */
const onPage = new Set([...HTML.matchAll(/href="(tel:[^"]+)"/g)].map(m => m[1]));

describe('офлайн-страница спасения', () => {
  it('страница вообще содержит номера — иначе сверять нечего', () => {
    expect(onPage.size).toBeGreaterThanOrEqual(4);
  });

  it('каждый номер реестра есть на странице', () => {
    const missing = EMERGENCY_NUMBERS
      .filter(n => !onPage.has(telHref(n.phone)))
      .map(n => `${n.name} (${n.phone})`);
    expect(missing, 'номер есть в приложении, но недоступен офлайн').toEqual([]);
  });

  it('на странице нет номеров вне реестра', () => {
    const known = new Set(EMERGENCY_NUMBERS.map(n => telHref(n.phone)));
    const extra = [...onPage].filter(t => !known.has(t));
    expect(extra, 'непроверенный номер в чрезвычайной ситуации опаснее его отсутствия').toEqual([]);
  });

  it('112 остаётся главным вызовом страницы', () => {
    expect(HTML).toMatch(/href="tel:112"[^>]*class="call-primary"/);
  });
});

describe('копии номеров в офлайн-хранилище нет', () => {
  it('IndexedDB не держит собственный список телефонов спасения', () => {
    // Он писался при скачивании региона и не читался ни разу: копия, которая
    // могла разойтись с реестром, ничего не давая взамен.
    const db = fs.readFileSync(path.join(process.cwd(), 'lib/offline/db.ts'), 'utf8');
    expect(db).not.toMatch(/GLOBAL_SOS_CONTACTS/);
    expect(db).not.toMatch(/export async function (get|save)(All)?SosContacts/);
  });
});
