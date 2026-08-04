/**
 * Переход должен быть виден, а висящая сеть — заканчиваться.
 *
 * Полевой прогон 04.08 (EDGE, «одна палка»): работала только главная, любой
 * переход выглядел как «ничего не происходит». Две независимые причины, обе
 * не про офлайн — офлайн как раз отработан честно:
 *
 *  1. Service worker ловил только ОТКЛОНЁННЫЙ fetch. При живой, но издыхающей
 *     сети запрос не отклоняется, он висит; `.catch` не срабатывает никогда,
 *     кэш не отдаётся. «Почти офлайн» в горах — обычное состояние связи, и
 *     именно его обработки не было.
 *  2. У страниц не было `loading.tsx` (6 из 210). App Router до готовности
 *     серверного компонента держит СТАРЫЙ экран: на быстрой сети незаметно,
 *     на медленной — молчание, неотличимое от сломанной кнопки.
 *
 * Сторож закрывает обе.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SW = read('public/sw.js');
const NAV = read('components/shared/BottomNav.tsx');
const HOME = read('app/_home/_HomeV8Client.tsx');

/** Куда уводит таб-бар: пути из ITEMS, без query. */
function tabBarRoutes(): string[] {
  const items = NAV.match(/href:\s*'([^']+)'/g) ?? [];
  return items
    .map((m) => m.replace(/href:\s*'|'/g, '').split('?')[0])
    .filter((p) => p.startsWith('/'));
}

/** Куда уводит блок безопасности главной: внутренние ссылки без query и якоря. */
function homeSafetyRoutes(): string[] {
  const hrefs = HOME.match(/href="(\/[^"#?]*)/g) ?? [];
  return hrefs.map((m) => m.replace('href="', ''));
}

function routeDir(pathname: string): string {
  return pathname === '/' ? 'app' : join('app', pathname.slice(1));
}

describe('service worker: висящая сеть заканчивается таймаутом', () => {
  it('навигация не ждёт сеть бесконечно', () => {
    expect(SW).toMatch(/NAV_TIMEOUT_MS/);
    expect(SW).toMatch(/function navigateWithTimeout/);
  });

  it('RSC-пейлоад тоже под таймаутом — иначе переход виснет молча', () => {
    expect(SW).toMatch(/RSC_TIMEOUT_MS/);
  });

  it('обе ветки навигации идут через таймаут, а не голый fetch', () => {
    // Ветка whitelist и общая ветка — обе должны звать общий помощник.
    const calls = SW.match(/navigateWithTimeout\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // объявление + два вызова
  });

  it('по таймауту отдаётся кэш, а без кэша сеть ждут дальше', () => {
    // Обрывать медленную, но живую загрузку нечем заменить: белый экран через
    // 4 секунды был бы враньём наоборот.
    const fn = SW.slice(SW.indexOf('function navigateWithTimeout'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(body).toMatch(/if \(cached\) done\(cached\)/);
  });

  it('кэш пересобран — иначе у телефонов останется старый worker', () => {
    const version = SW.match(/CACHE_NAME = 'kamchatour-v(\d+)'/)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(22);
  });
});

describe('навигация: переход виден сразу', () => {
  it('у каждой цели таб-бара есть скелетон', () => {
    const routes = tabBarRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      if (r === '/') continue; // главная — точка старта, не переход
      expect(existsSync(join(ROOT, routeDir(r), 'loading.tsx')), `${r}: нет loading.tsx`).toBe(true);
    }
  });

  it('у целей блока безопасности главной есть скелетон', () => {
    const routes = homeSafetyRoutes().filter((r) => existsSync(join(ROOT, routeDir(r), 'page.tsx')));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      if (r === '/') continue;
      expect(existsSync(join(ROOT, routeDir(r), 'loading.tsx')), `${r}: нет loading.tsx`).toBe(true);
    }
  });

  it('скелетон объявлен как состояние загрузки, а не немая заглушка', () => {
    const shared = read('components/shared/RouteLoading.tsx');
    expect(shared).toMatch(/role="status"/);
    expect(shared).toMatch(/aria-label="Загрузка/);
  });
});
