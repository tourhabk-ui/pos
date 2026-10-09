/**
 * Сторож: Яндекс.Метрика — один источник номера и опций, загрузка по
 * согласию и не везде, Вебвизор без содержимого полей с ПД.
 *
 * Счётчик 113581440 — вставка владельца 09.10. До этого номер жил в двух
 * местах с разными умолчаниями (загрузчик — `env ?? '103522218'`, цели
 * воронки — только env), и при незаданной переменной просмотры считались,
 * а цели — нет. Теперь номер один (`lib/analytics/metrika.ts`), и тест
 * держит связку: загрузчик, цели, пути-исключения, тишина полей, CSP.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  METRIKA_ID, METRIKA_INIT_OPTIONS, METRIKA_EXCLUDED_PREFIXES, METRIKA_TAG_URL,
  WEBVISOR_SILENT_CLASS, WEBVISOR_SILENT_FIELDS, metrikaInitScript, shouldTrackPath,
} from '@/lib/analytics/metrika';
import { THIRD_PARTIES } from '@/lib/legal/third-party-registry';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return /\.(ts|tsx)$/.test(name) ? [abs] : [];
  });
}
const SOURCES = ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d)))
  .map((abs) => ({ rel: relative(ROOT, abs), src: readFileSync(abs, 'utf8') }));

describe('номер счётчика — один', () => {
  it('константа равна счётчику владельца 09.10', () => {
    expect(METRIKA_ID).toBe(113581440);
  });

  it('переменная окружения и прежний номер больше нигде не читаются', () => {
    // Сам модуль хранит историю (прежний номер и переменную) в шапке — это
    // не чтение; остальной код их знать не должен.
    const stale = SOURCES
      .filter((f) => f.rel !== 'lib/analytics/metrika.ts' && /NEXT_PUBLIC_YANDEX_METRIKA_ID|103522218/.test(f.src))
      .map((f) => f.rel);
    expect(stale, 'второй источник номера счётчика — расхождение, с которого всё началось').toEqual([]);
  });

  it('ym(…, "init") зовётся только из metrikaInitScript', () => {
    const inits = SOURCES
      .filter((f) => f.rel !== 'lib/analytics/metrika.ts' && /ym\([^)]*["']init["']/.test(f.src))
      .map((f) => f.rel);
    expect(inits, 'второй сниппет инициализации — второй набор опций').toEqual([]);
  });
});

describe('инициализация — сниппет владельца', () => {
  const script = metrikaInitScript();

  it('опции те же, что во вставке 09.10', () => {
    expect(METRIKA_INIT_OPTIONS).toEqual({
      ssr: true, webvisor: true, clickmap: true, ecommerce: 'dataLayer', accurateTrackBounce: true, trackLinks: true,
    });
    expect(script).toContain(`ym(${METRIKA_ID},"init",{`);
    expect(script).toContain('"ecommerce":"dataLayer"');
    expect(script).toContain('referrer:document.referrer');
    expect(script).toContain('url:location.href');
  });

  it('dataLayer заводится до init, тег грузится с mc.yandex.ru', () => {
    expect(script.indexOf('window.dataLayer=window.dataLayer||[]')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('window.dataLayer')).toBeLessThan(script.indexOf('"init"'));
    expect(METRIKA_TAG_URL).toBe('https://mc.yandex.ru/metrika/tag.js');
    expect(script).toContain(METRIKA_TAG_URL);
  });
});

describe('загрузчик — по согласию, не везде, с хитами и тишиной полей', () => {
  const loader = read('components/legal/ThirdPartyScripts.tsx');

  it('Метрика в реестре третьих сторон как аналитика (грузится после согласия)', () => {
    const tp = THIRD_PARTIES.find((t) => t.id === 'YandexMetrika');
    expect(tp?.consentCategory).toBe('analytics');
    expect(tp?.host).toBe('mc.yandex.ru');
    expect(tp?.purpose, 'назначение должно называть Вебвизор — он включён').toMatch(/Вебвизор/);
  });

  it('тег берёт скрипт из metrikaInitScript и уважает shouldTrackPath', () => {
    expect(loader).toMatch(/metrikaInitScript\(\)/);
    expect(loader).toMatch(/if \(!shouldTrackPath\(pathname\)\) return null;/);
    expect(loader, 'пиксель без JavaScript шлёт хит до согласия').not.toMatch(/<noscript/);
  });

  it('переход внутри приложения отправляет просмотр, поля с ПД закрыты от Вебвизора', () => {
    expect(loader).toMatch(/<MetrikaRouteHits \/>/);
    expect(loader).toMatch(/metrikaHit\(url, previous\.current\)/);
    expect(loader).toMatch(/<WebvisorFieldGuard \/>/);
    expect(loader).toMatch(/new MutationObserver/);
    expect(loader).toMatch(/muteWebvisorFields\(document\)/);
  });

  it('цели воронки идут через тот же номер', () => {
    const tracking = read('lib/analytics/lead-tracking.ts');
    expect(tracking).toMatch(/from '@\/lib\/analytics\/metrika'/);
    expect(tracking).toMatch(/metrikaGoal\(event\.event_name/);
  });
});

describe('где счётчика нет', () => {
  it('кабинеты, вход, брони, контроль выхода, офлайн-контур — исключены', () => {
    for (const p of ['/hub', '/hub/operator/clients', '/hub/admin', '/auth/login', '/register', '/profile',
      '/booking-success/12', '/watch/abc', '/checkin-ok', '/sos', '/emergency', '/offline', '/field-check']) {
      expect(shouldTrackPath(p), `${p} должен быть без счётчика`).toBe(false);
    }
  });

  it('публичные страницы считаются, граница префикса — сегмент пути', () => {
    for (const p of ['/', '/catalog', '/catalog/tours/5', '/places/abc', '/routes/1', '/planner', '/planning',
      '/weather', '/safety', '/hubris', '/sos-history-not-a-thing/x'.replace('/sos-history-not-a-thing', '/soso')]) {
      expect(shouldTrackPath(p), `${p} должен считаться`).toBe(true);
    }
    expect(shouldTrackPath(null)).toBe(false);
  });

  it('у каждого исключения есть причина, и все префиксы — существующие разделы app/', () => {
    for (const { prefix, reason } of METRIKA_EXCLUDED_PREFIXES) {
      expect(reason.length).toBeGreaterThan(12);
      const dir = join(ROOT, 'app', prefix.slice(1));
      expect(statSync(dir).isDirectory(), `${prefix}: раздела нет — исключение протухло`).toBe(true);
    }
  });
});

describe('Вебвизор — поля с ПД не записываются', () => {
  it('класс тишины — ym-disable-keys, селектор закрывает телефон, почту, пароль, имя и свободный текст', () => {
    expect(WEBVISOR_SILENT_CLASS).toBe('ym-disable-keys');
    for (const part of ['input[type="tel"]', 'input[type="email"]', 'input[type="password"]',
      'input[autocomplete*="name"]', 'input[name*="phone" i]', 'input[name*="email" i]', 'textarea']) {
      expect(WEBVISOR_SILENT_FIELDS).toContain(part);
    }
  });
});

describe('CSP пропускает Метрику', () => {
  it('middleware и next.config разрешают mc.yandex.ru в script-src и connect-src', () => {
    // В middleware директивы собраны из констант (`const scriptSrc = "…"`),
    // в next.config — записаны в строке заголовка; читаются обе формы.
    const directive = (src: string, name: 'script' | 'connect'): string => {
      const asConst = src.match(new RegExp(`${name}Src\\s*=\\s*"([^"]*)"`, 'g')) ?? [];
      const inline = src.match(new RegExp(`${name}-src ([^;"\`]*)`, 'g')) ?? [];
      return [...asConst, ...inline].join(' ');
    };
    for (const f of ['middleware.ts', 'next.config.js']) {
      const src = read(f);
      expect(directive(src, 'script'), `${f}: script-src без mc.yandex.ru`).toMatch(/https:\/\/mc\.yandex\.ru/);
      expect(directive(src, 'connect'), `${f}: connect-src без mc.yandex.ru`).toMatch(/https:\/\/mc\.yandex\.ru/);
    }
  });
});
