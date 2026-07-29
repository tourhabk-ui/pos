/**
 * То, куда ведёт SOS, обязано лежать в precache service worker'а.
 *
 * Кнопка и кэш живут в разных файлах и правятся разными руками. Между ними
 * нет ничего, что заставило бы их сходиться: можно поменять адрес в
 * `EmergencyAction`, можно вынести `/emergency` из `CRITICAL_URLS` в
 * `OPTIONAL_URLS` — и оба раза сборка зелёная, тесты зелёные, а человек в поле
 * без сети жмёт SOS и получает страницу, которой нет в кэше.
 *
 * Отказ здесь тихий и полный: в офлайне нет ни ошибки, ни подсказки, просто
 * ничего не открывается. Узнали бы мы об этом от того, кто не смог позвать
 * помощь.
 *
 * Сторож не хранит адреса у себя — иначе он проверял бы собственную копию, а
 * не реальность. Оба адреса извлекаются из `EmergencyAction`: онлайновый из
 * `href`, офлайновый из `router.push(...)`. Поменяется адрес — сторож
 * потребует того же в sw.js, а не промолчит.
 *
 * Чего этот тест НЕ доказывает: что precache реально установился на телефоне.
 * Это проверяется только устройством в авиарежиме — здесь мы лишь гарантируем,
 * что проверять будет что.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ACTION = readFileSync(join(ROOT, 'components/shared/EmergencyAction.tsx'), 'utf-8');
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');

/** Комментарии цитируют адреса — сравнивать надо код, а не пояснения. */
function code(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Список строковых литералов из массива-константы в sw.js. */
function urlList(name: string): string[] {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(SW);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

const CRITICAL = urlList('CRITICAL_URLS');
const OPTIONAL = urlList('OPTIONAL_URLS');

/** Куда SOS уходит офлайн, когда экран не дал своей инлайн-панели. */
function offlineTarget(): string | null {
  const m = /router\.push\(\s*['"]([^'"]+)['"]\s*\)/.exec(code(ACTION));
  return m ? m[1] : null;
}

/** Куда SOS ведёт при живой сети. */
function onlineTarget(): string | null {
  const m = /href=["']([^"']+)["']/.exec(code(ACTION));
  return m ? m[1] : null;
}

describe('sw.js вообще разобрался', () => {
  it('списки precache прочитаны — иначе сторож молчал бы впустую', () => {
    expect(CRITICAL.length).toBeGreaterThan(2);
    expect(OPTIONAL.length).toBeGreaterThan(0);
  });
});

describe('адреса SOS лежат в критичном precache', () => {
  it('офлайн-адрес извлечён из компонента, а не придуман тестом', () => {
    expect(offlineTarget()).toBeTruthy();
  });

  it('офлайн-адрес precached как критичный', () => {
    const target = offlineTarget();
    expect(CRITICAL, `SOS офлайн ведёт на ${target}, но этого нет в CRITICAL_URLS`).toContain(target);
  });

  it('онлайн-адрес тоже precached — сеть может отвалиться после загрузки', () => {
    const target = onlineTarget();
    expect(CRITICAL, `SOS ведёт на ${target}, но этого нет в CRITICAL_URLS`).toContain(target);
  });

  it('ни один адрес SOS не понижен до OPTIONAL', () => {
    // Понижение — самый тихий способ сломать офлайн: URL на месте, список
    // на месте, но его отсутствие уже «не ломает СОС» по определению файла.
    for (const t of [offlineTarget(), onlineTarget()]) {
      expect(OPTIONAL, `${t} понижен до OPTIONAL_URLS`).not.toContain(t);
    }
  });
});

describe('критичный precache не стал атомарным снова', () => {
  it('URL кэшируются поштучно, а не одним addAll', () => {
    // 07.2026, фидбэк с Халактырского пляжа: один cache.addAll(...) на всё
    // ронял ВЕСЬ precache из-за одного редиректа или 404 — вместе с
    // /emergency. Возврат к addAll по критичному списку это повторит.
    const c = code(SW);
    expect(c).toMatch(/cacheOne\s*\(/);
    const addAllOnCritical = /addAll\(\s*CRITICAL_URLS\s*\)/.test(c);
    expect(addAllOnCritical, 'CRITICAL_URLS снова кэшируется атомарно').toBe(false);
  });
});
