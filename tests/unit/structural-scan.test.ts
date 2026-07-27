/**
 * Структурные объективы эволюции (lib/agents/evo/structural-scan.ts).
 *
 * Чистые функции — тестируем на синтетике, плюс живой прогон сироты-проверки
 * по реальному дереву репозитория: она обязана находить те же классы дыр, что
 * ручной аудит 27.07 (сироты трансфер-оператора), и молчать про onboarding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  findOrphanHubPages,
  findPostWithoutClientUsage,
  hubLayoutPaths,
  ORPHAN_EXCLUDED_SEGMENTS,
} from '@/lib/agents/evo/structural-scan';

describe('findOrphanHubPages (синтетика)', () => {
  const files = [
    'app/hub/demo/layout.tsx',
    'app/hub/demo/page.tsx',
    'app/hub/demo/linked/page.tsx',
    'app/hub/demo/orphan/page.tsx',
    'app/hub/demo/onboarding/page.tsx',
    'app/hub/demo/items/[id]/page.tsx',
    'app/hub/nolayout/lost/page.tsx',
  ];
  const layouts = new Map([
    ['app/hub/demo/layout.tsx', "const S = [{ href: '/hub/demo' }, { href: '/hub/demo/linked' }];"],
  ]);

  it('находит страницу вне сайдбара, молчит про подключённые', () => {
    const found = findOrphanHubPages(files, layouts);
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain('/hub/demo/orphan');
    expect(found[0].category).toBe('ux');
  });

  it('onboarding исключён by design, динамические сегменты не проверяются', () => {
    const titles = findOrphanHubPages(files, layouts).map((f) => f.title);
    expect(titles.join()).not.toContain('onboarding');
    expect(titles.join()).not.toContain('[id]');
    expect(ORPHAN_EXCLUDED_SEGMENTS.has('onboarding')).toBe(true);
  });

  it('хаб без прочитанного layout — молчание, а не ложная находка', () => {
    const titles = findOrphanHubPages(files, layouts).map((f) => f.title);
    expect(titles.join()).not.toContain('nolayout');
  });
});

describe('findPostWithoutClientUsage (синтетика)', () => {
  const route = (post: boolean) =>
    `import { z } from 'zod';\n${post ? "export async function POST(req) { return null; }" : ''}\nexport async function GET(req) { return null; }`;

  it('POST есть, клиент читает URL, но не шлёт POST — находка', () => {
    const found = findPostWithoutClientUsage(
      new Map([['app/api/gear/items/route.ts', route(true)]]),
      new Map([['app/hub/gear/_C.tsx', "useApiFetch('/api/gear/items', d => d)"]]),
    );
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain('/api/gear/items');
  });

  it('клиент шлёт POST — молчание', () => {
    const found = findPostWithoutClientUsage(
      new Map([['app/api/gear/items/route.ts', route(true)]]),
      new Map([['app/hub/gear/_C.tsx', "fetch('/api/gear/items', { method: 'POST' })"]]),
    );
    expect(found).toHaveLength(0);
  });

  it('URL нигде не упоминается (межсервисный роут) — молчание', () => {
    const found = findPostWithoutClientUsage(
      new Map([['app/api/gear/internal/route.ts', route(true)]]),
      new Map([['app/hub/gear/_C.tsx', 'ничего про этот путь']]),
    );
    expect(found).toHaveLength(0);
  });

  it('роут без POST и динамические пути — вне проверки', () => {
    const found = findPostWithoutClientUsage(
      new Map([
        ['app/api/gear/list/route.ts', route(false)],
        ['app/api/gear/items/[id]/route.ts', route(true)],
      ]),
      new Map([['app/hub/gear/_C.tsx', "'/api/gear/list' '/api/gear/items/'"]]),
    );
    expect(found).toHaveLength(0);
  });
});

describe('живой прогон по дереву репозитория', () => {
  function walkPages(dir: string, acc: string[]): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkPages(full, acc);
      else if (name === 'page.tsx' || name === 'layout.tsx') {
        acc.push(full.replace(process.cwd() + '/', ''));
      }
    }
  }

  it('после аудита 27.07 сироты закрыты или осознанно исключены — кроме известного бэклога', () => {
    const files: string[] = [];
    walkPages(join(process.cwd(), 'app/hub'), files);
    const layouts = new Map<string, string>();
    for (const p of hubLayoutPaths(files)) {
      layouts.set(p, readFileSync(join(process.cwd(), p), 'utf-8'));
    }
    const found = findOrphanHubPages(files, layouts).map((f) => f.title);

    // Трансфер-оператор починен в #838 — его сирот быть не должно.
    expect(found.join()).not.toContain('/hub/transfer-operator');

    // Известный бэклог на момент внедрения объектива (найден им же 27.07):
    // движок заведёт issues, чинить будем по приоритету владельца. Новая
    // сирота сверх списка — регресс, тест падает.
    const KNOWN_BACKLOG = new Set([
      'Страница вне сайдбара хаба: /hub/operator/ai-assist',
      'Страница вне сайдбара хаба: /hub/operator/booking-intake',
      'Страница вне сайдбара хаба: /hub/operator/guides',
      'Страница вне сайдбара хаба: /hub/operator/register',
      'Страница вне сайдбара хаба: /hub/tourist/eco-points',
    ]);
    const unexpected = found.filter((t) => !KNOWN_BACKLOG.has(t));
    expect(unexpected, `новые сироты: ${unexpected.join('; ')}`).toEqual([]);
  });
});
