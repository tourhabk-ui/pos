/**
 * Один сайт — один адрес.
 *
 * tourhab.ru и vedarai.ru отдавали одно и то же. Для поисковика и для
 * ИИ-агента это два разных сайта с одинаковым содержимым: ссылки, цитирования
 * и вес делятся пополам, а партнёр ставит ссылку наугад. Канонические теги на
 * страницах уже указывали на vedarai.ru — но тег это просьба, а 308 это ответ.
 *
 * Тесты стерегут три вещи: канон объявлен, он постоянный, и /api из него
 * исключён — вебхуки редиректов не ходят.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL = 'vedarai.ru';
const LEGACY = 'tourhab.ru';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require(join(process.cwd(), 'next.config.js')) as {
  redirects: () => Promise<Array<{
    source: string;
    destination: string;
    permanent?: boolean;
    has?: Array<{ type: string; value: string }>;
  }>>;
};

async function hostRules() {
  const all = await config.redirects();
  return all.filter(r => r.has?.some(h => h.type === 'host' && h.value.includes('tourhab')));
}

describe('канон домена', () => {
  it('старый хост уводит на канонический', async () => {
    const rules = await hostRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.destination).toContain(CANONICAL);
      expect(r.destination).not.toContain(LEGACY);
    }
  });

  it('редирект постоянный — временный не переносит вес', async () => {
    for (const r of await hostRules()) expect(r.permanent).toBe(true);
  });

  it('корень тоже уводится: без него главная остаётся дублем', async () => {
    const rules = await hostRules();
    expect(rules.some(r => r.source === '/')).toBe(true);
  });

  it('/api исключён — вебхуки редиректов не ходят', async () => {
    // Telegram, MAX и приёмники оплат увидят 308 и посчитают доставку
    // неудачной. Канон нужен странице, которую читают люди и агенты.
    const rules = await hostRules();
    const wildcard = rules.find(r => r.source !== '/');
    expect(wildcard?.source).toContain('(?!api/)');
  });
});

describe('канон в метаданных', () => {
  const layout = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf-8');
  const robots = readFileSync(join(process.cwd(), 'app/robots.ts'), 'utf-8');

  it('база метаданных — канонический домен', () => {
    expect(layout).toContain(CANONICAL);
    expect(layout).not.toContain(LEGACY);
  });

  it('robots объявляет тот же host, что и редирект', () => {
    expect(robots).toContain(CANONICAL);
    expect(robots).not.toContain(LEGACY);
  });
});
