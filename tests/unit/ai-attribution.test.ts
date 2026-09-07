/**
 * tests/unit/ai-attribution.test.ts
 *
 * Витрина OpenRouter обязана отвечать на вопрос «прод или CI».
 *
 * ── Случай 07.09 ──────────────────────────────────────────────────────────
 *
 * Два экрана рядом. Консоль OpenRouter: приложение `vedarai.ru`, 1,12 млн
 * токенов за две недели, 50-90 тыс. в сутки, ровным строем. Наш алерт:
 * «OpenRouter недоступен». Оба верны — с прода 403 (край сети режет по нашему
 * адресу), а токены жжёт раннер GitHub. Но узнать это по витрине было нельзя:
 * `HTTP-Referer` был захардкожен строкой `https://vedarai.ru` во всех
 * шестнадцати местах вызова, а OpenRouter группирует приложения именно по нему.
 *
 * Два РАЗНЫХ ключа (секреты GitHub против переменных Timeweb) заводились ровно
 * ради адресности отказа (§8 CLAUDE.md) — и адресность терялась в подписи.
 *
 * Сторож держит три вещи: подпись берётся из одного места, поверхности
 * различимы, а «место не определено» не выдаётся за прод.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openRouterAttribution } from '@/lib/ai/attribution';

describe('подпись различает поверхности', () => {
  const prod = { ...process.env, NODE_ENV: 'production', GITHUB_ACTIONS: undefined };
  const ci = { ...process.env, GITHUB_ACTIONS: 'true' };

  function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
    const saved = { NODE_ENV: process.env.NODE_ENV, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
    Object.assign(process.env, { NODE_ENV: env.NODE_ENV, GITHUB_ACTIONS: env.GITHUB_ACTIONS });
    if (env.GITHUB_ACTIONS === undefined) delete process.env.GITHUB_ACTIONS;
    try { return fn(); } finally { Object.assign(process.env, saved); }
  }

  it('прод и раннер получают РАЗНЫЕ адреса приложения', () => {
    const a = withEnv(prod, () => openRouterAttribution());
    const b = withEnv(ci, () => openRouterAttribution());
    expect(a['HTTP-Referer']).not.toBe(b['HTTP-Referer']);
    expect(a['X-Title']).not.toBe(b['X-Title']);
  });

  it('адрес прода не меняется — иначе рвётся история приложения 3981361', () => {
    // На витрине у него отсчёт с 5 июня. Новый адрес завёл бы вторую строку,
    // и сравнить «до» и «после» стало бы не с чем.
    expect(withEnv(prod, () => openRouterAttribution())['HTTP-Referer'])
      .toBe('https://vedarai.ru');
  });

  it('раннер называет себя раннером — в адресе, а не только в имени', () => {
    // OpenRouter группирует по Referer: подпись в одном лишь X-Title
    // (как было у editor-runner и astra-probe) на витрину не попадает.
    expect(withEnv(ci, () => openRouterAttribution())['HTTP-Referer']).toContain('/ci');
  });

  it('неопределённое место не сваливается в «прод»', () => {
    const unknown = withEnv({ NODE_ENV: undefined, GITHUB_ACTIONS: undefined }, () => openRouterAttribution());
    expect(unknown['HTTP-Referer']).not.toBe('https://vedarai.ru');
  });

  it('роль уточняет имя, но не дробит адрес', () => {
    const plain = withEnv(ci, () => openRouterAttribution());
    const roled = withEnv(ci, () => openRouterAttribution('editor'));
    expect(roled['X-Title']).toContain('editor');
    expect(roled['HTTP-Referer']).toBe(plain['HTTP-Referer']);
  });

  it('значения заголовков — только ASCII (кириллица роняет fetch)', () => {
    for (const env of [prod, ci]) {
      const h = withEnv(env, () => openRouterAttribution('роль-с-кириллицей'));
      expect(h['X-Title']).toMatch(/^[\x20-\x7E]*$/);
      expect(h['HTTP-Referer']).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

describe('второй копии подписи в коде нет', () => {
  const ROOTS = ['lib', 'app', 'scripts'];
  const HELPER = join('lib', 'ai', 'attribution.ts');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('HTTP-Referer задаётся ровно в одном файле', () => {
    const offenders = ROOTS
      .flatMap(r => walk(join(process.cwd(), r)).map(p => p.replace(process.cwd() + '/', '')))
      .filter(p => p !== HELPER)
      // Реестр соответствия (D2) упоминает заголовок в прозе, а не задаёт его.
      .filter(p => !p.endsWith('provider-registry.ts'))
      .filter(p => /['"]HTTP-Referer['"]\s*:/.test(readFileSync(join(process.cwd(), p), 'utf-8')));

    expect(offenders, `подпись вернулась в код: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('алерт здоровья называет место замера', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf-8');
  const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('«недоступен» не остаётся без места', () => {
    expect(CODE).toMatch(/OpenRouter недоступен с прода/);
  });

  it('о непроверенном раннерном пути сказано вслух, а не умолчано', () => {
    expect(CODE).toMatch(/раннера GitHub этой пробой не проверялся/);
  });

  it('у Anthropic то же самое: место замера названо', () => {
    expect(CODE).toMatch(/Anthropic недоступен с прода/);
  });
});
