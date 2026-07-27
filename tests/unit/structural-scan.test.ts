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

  it('страница-редирект (сохранённый старый URL) — не сирота', () => {
    const pageBodies = new Map([
      ['app/hub/demo/orphan/page.tsx', "import { redirect } from 'next/navigation';\nexport default function R() { redirect('/hub/demo/linked'); }"],
    ]);
    expect(findOrphanHubPages(files, layouts, pageBodies)).toHaveLength(0);
    // Без тела страницы находка сохраняется — лучше находка, чем молчание.
    expect(findOrphanHubPages(files, layouts, new Map())).toHaveLength(1);
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

  it('сирот в хабах НОЛЬ: аудит 27.07 закрыл все (нав/редирект), новая — регресс', () => {
    const files: string[] = [];
    walkPages(join(process.cwd(), 'app/hub'), files);
    const layouts = new Map<string, string>();
    for (const p of hubLayoutPaths(files)) {
      layouts.set(p, readFileSync(join(process.cwd(), p), 'utf-8'));
    }
    // Тот же двухпроходный протокол, что в scanStructural: кандидаты →
    // чтение их тел → redirect-страницы отсеяны.
    const candidates = findOrphanHubPages(files, layouts);
    const pageBodies = new Map<string, string>();
    for (const c of candidates) {
      if (c.file_path) pageBodies.set(c.file_path, readFileSync(join(process.cwd(), c.file_path), 'utf-8'));
    }
    const found = findOrphanHubPages(files, layouts, pageBodies).map((f) => f.title);
    expect(found, `сироты: ${found.join('; ')}`).toEqual([]);
  });

  it('POST-без-формы в кабинетах НОЛЬ: у каждого создания есть форма в UI', () => {
    function walkSources(dir: string, acc: string[]): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkSources(full, acc);
        else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.')) {
          acc.push(full.replace(process.cwd() + '/', ''));
        }
      }
    }
    const files: string[] = [];
    walkSources(join(process.cwd(), 'app'), files);
    walkSources(join(process.cwd(), 'components'), files);

    const routeBodies = new Map<string, string>();
    for (const p of files.filter((f) => /^app\/api\/.*\/route\.ts$/.test(f))) {
      routeBodies.set(p, readFileSync(join(process.cwd(), p), 'utf-8'));
    }
    const clientBodies = new Map<string, string>();
    for (const p of files.filter((f) => f.endsWith('.tsx'))) {
      clientBodies.set(p, readFileSync(join(process.cwd(), p), 'utf-8'));
    }
    const found = findPostWithoutClientUsage(routeBodies, clientBodies).map((f) => f.title);
    expect(found, `POST без формы: ${found.join('; ')}`).toEqual([]);
  });
});
