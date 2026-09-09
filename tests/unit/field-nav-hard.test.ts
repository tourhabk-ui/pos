/**
 * Переход на форму находки обязан быть ЖЁСТКИМ, пока она живёт из прекэша.
 *
 * Разбор #1750: восемь переходов через `window.location` — полная
 * перезагрузка вместо клиентского перехода. Семь из восьми оказались
 * небрежностью и переведены на Link/router.push. Восьмой — нет, и разница
 * тут не в стиле, а в том, откроется ли экран без сети.
 *
 * Механика (public/sw.js): service worker кладёт в прекэш ДОКУМЕНТ
 * '/field-check' — отдельным списком FIELD_URLS, с повторами, потому что
 * «их открывают именно там, где связи нет, и один промах прекэша стоит
 * всего выхода». Офлайн этот документ отдаётся из кэша
 * (OFFLINE_CAPABLE_ROUTES).
 *
 * Клиентский переход Next документа не запрашивает вовсе: он идёт за
 * RSC-полезной нагрузкой по другому адресу (/field-check?_rsc=...). В кэше
 * её нет. То есть «починка» жёсткого перехода на router.push выключила бы
 * форму находки ровно там, где она нужна — на маршруте без связи, где
 * переспросить не у кого.
 *
 * Сторож держит СВЯЗКУ, а не одну из её половин: пока экран в прекэше —
 * переход жёсткий; уйдёт из прекэша — этот тест покраснеет и заставит
 * пересмотреть переход, а не молча оставить его «на всякий случай».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const PLANNING = read('app/planning/_PlanningClient.tsx');
const SW = read('public/sw.js');

/** Кусок массива по имени: `const NAME = [ ... ];` */
function arrayBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = [`);
  if (start === -1) return '';
  const end = src.indexOf('];', start);
  return end === -1 ? '' : src.slice(start, end);
}

describe('форма находки доступна без сети', () => {
  it('документ /field-check лежит в прекэше с повторами', () => {
    expect(arrayBody(SW, 'FIELD_URLS'), 'ушёл из прекэша — офлайн форму не откроет')
      .toContain("'/field-check'");
  });

  it('офлайн ему отдаётся кэш, а не страница «нет соединения»', () => {
    expect(arrayBody(SW, 'OFFLINE_CAPABLE_ROUTES')).toContain("'/field-check'");
  });
});

describe('переход на неё — жёсткий, раз она из прекэша', () => {
  it('planning зовёт location.assign, а не клиентский переход', () => {
    expect(PLANNING, 'клиентский переход попросит RSC вместо документа — офлайн пусто')
      .toMatch(/window\.location\.assign\('\/field-check\?place=1'\)/);
    expect(PLANNING).not.toMatch(/router\.(push|replace)\(['"`]\/field-check/);
  });

  it('подавление правила линтера подписано причиной, а не голое', () => {
    // Голая директива без объяснения через месяц неотличима от забытой —
    // именно такие 37 штук вычищены 09.09 в #1749.
    const idx = PLANNING.indexOf('no-location-assign-relative-destination');
    expect(idx, 'директива пропала — правило снова начнёт звать «починить»').toBeGreaterThan(-1);
    const before = PLANNING.slice(Math.max(0, idx - 700), idx);
    expect(before, 'подавление без причины — это выключенная сигнализация')
      .toMatch(/прекэш|sw\.js|без сети/);
  });
});

describe('остальные семь переходов из #1750 переведены', () => {
  const cases: Array<[string, string]> = [
    ['app/planner/_PlannerClient.tsx', 'router.push'],
    ['components/agent/Dashboard/RecentClientsTable.tsx', 'Link'],
    ['components/agent/Dashboard/UpcomingBookingsTable.tsx', 'Link'],
    ['components/shared/AccommodationCard.tsx', 'Link'],
  ];

  it.each(cases)('%s больше не перезагружает страницу', (file) => {
    const src = read(file);
    expect(src, 'вернулась полная перезагрузка вместо клиентского перехода')
      .not.toMatch(/window\.location\.(href\s*=|assign\(|replace\()/);
  });

  it('карточка жилья не заводит второй переход поверх своей же ссылки', () => {
    const src = read('components/shared/AccommodationCard.tsx');
    // Вся карточка обёрнута в Link на тот же адрес. Кнопка внутри, гасившая
    // его переход ради перезагрузки на ТОТ ЖЕ URL, была строго хуже, чем
    // ничего; заодно <button> внутри <a> невалиден по HTML.
    expect(src).toMatch(/<Link href=\{`\/accommodations\/\$\{id\}`\}>/);
    expect(src, 'вложенная кнопка вернулась — снова два таб-стопа и отменённый переход')
      .not.toMatch(/<button[^>]*\n?[^>]*onClick=\{\(e\) => \{\s*e\.preventDefault\(\)/);
  });
});
