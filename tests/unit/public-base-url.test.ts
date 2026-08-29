/**
 * Сторож публичного базового URL: одно правило, и оно судит по имени хоста.
 *
 * 23.08.2026 разбор CodeQL напечатал 15 находок js/incomplete-url-substring-
 * sanitization. За ними стояло не пятнадцать мест, а ОДНО правило в двенадцати
 * копиях — включая две копии внутри самого lib/config.ts, рядом с функцией,
 * которая для этого и заведена.
 *
 * Копии уже разъехались, и оба расхождения — в исходящих ссылках:
 *   • app/api/bookings/payments/route.ts — хвостового фолбэка не было вовсе,
 *     returnUrl оплаты выходил строкой `undefined/bookings/<id>`;
 *   • app/api/admin/operators/verify/route.ts — фолбэком была пустая строка,
 *     то есть в письме уезжала относительная ссылка `/auth/login`.
 *
 * Третья реализация жила в вебхуке Telegram и судила регуляркой без якоря.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isTechnicalHost, getPublicBaseUrl, CANONICAL_BASE_URL } from '@/lib/config';

describe('isTechnicalHost: судит по имени хоста', () => {
  it('технический хост Timeweb опознаётся', () => {
    // Форма из репозитория: поддомен (lib/db-pool.ts, tests/unit/lead-links).
    expect(isTechnicalHost('https://pospkam-pospktry-c1f3.twc1.net')).toBe(true);
    expect(isTechnicalHost('https://8ad609fcbfd2ad0bd069be47.twc1.net/x')).toBe(true);
    expect(isTechnicalHost('https://twc1.net')).toBe(true);
  });

  it('чужой адрес с той же подстрокой техническим НЕ становится', () => {
    // Ровно это и ловил CodeQL: подстрока может стоять где угодно в URL.
    expect(isTechnicalHost('https://example.com/?ref=twc1.net')).toBe(false);
    expect(isTechnicalHost('https://twc1.net.example.com')).toBe(false);
    expect(isTechnicalHost('https://nottwc1.net')).toBe(false);
  });

  it('наш публичный домен техническим не считается', () => {
    expect(isTechnicalHost(CANONICAL_BASE_URL)).toBe(false);
  });

  it('пусто — это не «технический», это «не задано»', () => {
    expect(isTechnicalHost(undefined)).toBe(false);
    expect(isTechnicalHost('')).toBe(false);
  });

  it('не адрес — наружу не пускаем', () => {
    // Третий исход: разобрать не смогли, значит не знаем, наш он или чужой.
    expect(isTechnicalHost('вообще не адрес')).toBe(true);
  });
});

/**
 * Оговорка про две находки CodeQL на фикстурах ниже.
 *
 * js/incomplete-hostname-regexp метит строки `https://…twc1.net` и
 * `https://stage.example.com` в этом файле. Ссылка в сообщении ведёт не сюда,
 * а в lib/notifications/post-validation.ts:99 — там из публичного базового URL
 * строится регулярка для поиска внутренних ссылок в тексте поста.
 *
 * Прочитано 23.08.2026: значение ТАМ экранируется —
 * `appUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`, точка в наборе есть.
 * Дефекта нет; CodeQL просто не признаёт эту функцию экранированием, а мои
 * фикстуры дали ему конкретную строку-источник, которой раньше не было.
 *
 * Записано, чтобы следующий читатель не разбирал это заново.
 */
describe('getPublicBaseUrl: у ссылки наружу всегда есть домен', () => {
  const saved = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });
  afterEach(() => {
    if (saved.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved.app;
    if (saved.site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved.site;
  });

  it('ничего не задано — канон, а не пустая строка и не undefined', () => {
    // Обе прежние копии здесь врали по-своему: одна давала '', другая —
    // строку "undefined" внутри адреса возврата после оплаты.
    const base = getPublicBaseUrl();
    expect(base).toBe(CANONICAL_BASE_URL);
    expect(base).not.toBe('');
    expect(`${base}/bookings/1`).not.toContain('undefined');
  });

  it('технический хост подменяется публичным', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://pospkam-pospktry-c1f3.twc1.net';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://vedarai.ru';
    expect(getPublicBaseUrl()).toBe('https://vedarai.ru');
  });

  it('обычный домен берётся как есть', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://stage.example.com';
    expect(getPublicBaseUrl()).toBe('https://stage.example.com');
  });
});

describe('правило одно на весь репозиторий', () => {
  // .claude — не исключение ради тишины, а факт устройства репозитория:
  // под ним живут .claude/worktrees/*, полные копии дерева от параллельных
  // сессий агентов на СВОИХ ветках. Без исключения обход от process.cwd()
  // читал их исходники наравне со своими — сторож ловил чужой незакоммиченный
  // код и красил прогон на состоянии, которого в HEAD нет вовсе.
  const SKIP = new Set(['node_modules', '.next', '.git', '.claude', 'public', 'migrations', 'docs']);
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|mjs)$/.test(e)) acc.push(p);
    }
    return acc;
  };

  it('вхождение подстроки twc1.net больше нигде не решает', () => {
    const offenders: string[] = [];
    for (const f of walk(process.cwd())) {
      if (f.endsWith('lib/config.ts') || f.includes(join('tests', 'unit'))) continue;
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      // Подстрочная проверка в любом виде: includes, indexOf, регулярка.
      if (/includes\(\s*['"][^'"]*twc1\.net/.test(src)) offenders.push(`${f}: includes`);
      if (/indexOf\(\s*['"][^'"]*twc1\.net/.test(src)) offenders.push(`${f}: indexOf`);
      if (/\/[^/\n]*twc1\\?\.net[^/\n]*\/[gimsuy]*\.test\(/.test(src)) offenders.push(`${f}: регулярка`);
    }
    expect(offenders, `правило снова размножилось: ${offenders.join(', ')}`).toEqual([]);
  });

  it('обход не заходит в .claude/worktrees — чужие ветки не читаются', () => {
    // Регрессия 30.08: SKIP не знал про .claude, и обход от process.cwd()
    // спускался в .claude/worktrees/* — полные копии дерева параллельных
    // сессий на своих ветках. Прогон красился на код, которого в HEAD нет.
    expect(SKIP.has('.claude')).toBe(true);
    for (const f of walk(process.cwd())) {
      expect(f, 'обход зашёл под .claude вопреки SKIP').not.toMatch(/\/\.claude\//);
    }
  });
});
