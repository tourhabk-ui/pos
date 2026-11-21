// @vitest-environment jsdom
/**
 * Экран SOS на браузере без `crypto.randomUUID` (экран в машине, 21.11).
 *
 * Владелец открыл /sos на экране в машине — старый Chrome на Android — и
 * получил «Произошла ошибка»: экран SOS в рендере звал
 * `crypto.randomUUID()`, а его в Chrome нет до 92-й версии. Объект `crypto`
 * при этом есть, поэтому проверка `typeof crypto !== 'undefined'` пропускала
 * вызов: «crypto.randomUUID is not a function».
 *
 * Сторож держит:
 *   - запасной путь `randomUuid` (getRandomValues, формат v4) и исход «нет
 *     криптографии» — вызовом;
 *   - экран SOS рендерится с 112 в браузере без `randomUUID` — рендером;
 *   - меш SOS (`VolcanoMesh`) создаётся и шлёт SOS без `randomUUID` — вызовом;
 *   - запрет: клиентский файл не зовёт `crypto.randomUUID` сам, кроме
 *     записанных в CLIENT_GUARDED со своей проверкой наличия. Новый — красный;
 *     запись, чей файл больше не зовёт, — тоже (самоустаревание).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { randomUuid, dedupId } from '@/lib/security/random-uuid';

const ROOT = process.cwd();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Chrome до 92: crypto есть, randomUUID нет. */
function withoutRandomUuid() {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID');
  const proto = Object.getPrototypeOf(globalThis.crypto) as object;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  return () => {
    delete (globalThis.crypto as unknown as Record<string, unknown>).randomUUID;
    if (original && !('randomUUID' in proto)) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', original);
    }
  };
}

describe('randomUuid — запасной путь', () => {
  it('есть randomUUID — его ответ', () => {
    expect(randomUuid({ randomUUID: () => 'from-native' })).toBe('from-native');
  });

  it('нет randomUUID, есть getRandomValues — UUID v4 из случайных байтов', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = randomUuid({ getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a) });
      expect(id).toMatch(V4);
      ids.add(id as string);
    }
    expect(ids.size).toBe(50);
  });

  it('нет криптографии — null, а не угадываемое значение', () => {
    expect(randomUuid(null)).toBeNull();
    expect(randomUuid({})).toBeNull();
  });

  it('dedupId без криптографии не падает и не пуст', () => {
    const restore = withoutRandomUuid();
    try {
      expect(dedupId('sos')).toMatch(V4);
    } finally {
      restore();
    }
  });
});

// Тяжёлые части экрана, к поломке не причастные: анимация на canvas, камера,
// чат с моделью, предложение пушей. Сам экран и его код — настоящие.
vi.mock('@/components/ui/LottiePlayer', () => ({ default: () => null }));
vi.mock('@/components/safety/SosQrScanner', () => ({ SosQrScanner: () => null }));
vi.mock('@/components/safety/RescueChat', () => ({ default: () => null }));
vi.mock('@/components/PWA/PushSafetyOffer', () => ({ PushSafetyOffer: () => null }));

describe('экран SOS в браузере без randomUUID (Chrome до 92)', () => {
  let restore: () => void = () => {};
  beforeEach(() => { restore = withoutRandomUuid(); });
  afterEach(() => { restore(); cleanup(); });

  it('рендерится, и звонок 112 на месте', async () => {
    const { default: SosPage } = await import('@/app/sos/page');
    render(<SosPage />);
    const calls = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === 'tel:112');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('меш SOS создаётся и шлёт сигнал', async () => {
    const { VolcanoMesh } = await import('@/lib/mesh/volcano-mesh');
    const mesh = new VolcanoMesh();
    expect(() => mesh.sendSOS({ lat: 53, lng: 158 } as never)).not.toThrow();
  });
});

/**
 * Клиентские файлы, где к `randomUUID` обращаются со своей проверкой наличия.
 * Новое клиентское обращение — через lib/security/random-uuid.ts.
 */
const CLIENT_GUARDED: Record<string, string> = {
  'lib/security/random-uuid.ts': 'сам запасной путь: typeof === function, запас getRandomValues',
  'components/kuzmich/KuzmichWidget.tsx': 'проверка c?.randomUUID, запас getRandomValues с префиксом w-',
  'components/shared/PageViewTracker.tsx': 'проверка typeof === function, запас getRandomValues',
  'components/PWA/InstallTracker.tsx': 'проверка if (crypto.randomUUID)',
  'components/shared/AssistantButton.tsx': 'проверка наличия в тернарном выражении',
  'app/kuzmich/_KuzmichClient.tsx': 'вызов через ?.()',
  'app/planner/_PlannerClient.tsx': 'проверка typeof === function',
  'lib/safety/register-submit.ts': 'проверка typeof === function, запас getRandomValues',
};

/** Серверный файл: роут API, пул базы, node:crypto, server-only. */
function isServer(rel: string, src: string): boolean {
  if (rel.startsWith('app/api/')) return true;
  return /from ['"](@\/lib\/db-pool|@\/lib\/database|node:crypto|crypto|server-only)['"]/.test(src)
    || /import ['"]server-only['"]/.test(src)
    || /\bimport\s*\{[^}]*\bpool\b[^}]*\}\s*from/.test(src);
}

/**
 * Где лежит код, который исполняет браузер: каталоги приложения, провайдеры
 * `contexts/` (их рендерит корневой layout) и скрипты `public/` (service
 * worker, виджет, офлайн-модули SOS). Ревью безопасности #3634: первая
 * редакция читала только app, components, hooks и lib.
 */
const CLIENT_ROOTS = ['app', 'components', 'contexts', 'hooks', 'lib', 'public'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(relative(ROOT, p));
    }
  };
  for (const d of CLIENT_ROOTS) walk(join(ROOT, d));
  return out.sort();
}

/**
 * Любое обращение к randomUUID в коде, без строк-комментариев: вызов,
 * деструктуризация (`const { randomUUID: rid } = crypto`), индекс
 * (`crypto['randomUUID']`), `.call` / `.bind`. Ревью безопасности #3634:
 * первая редакция ловила только форму `randomUUID(`.
 */
function mentionsRandomUuid(src: string): boolean {
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return /randomUUID/.test(code);
}

describe('запрет: клиентский код не обращается к crypto.randomUUID сам', () => {
  it('корни включают провайдеры и скрипты public', () => {
    const files = sourceFiles();
    expect(files.some((f) => f.startsWith('contexts/'))).toBe(true);
    expect(files).toContain('public/sw.js');
  });

  it('деструктуризация, индекс и .call — тоже обращение', () => {
    for (const src of [
      'const { randomUUID: rid } = crypto; rid();',
      "const rid = crypto['randomUUID']; rid();",
      'const id = crypto.randomUUID.call(crypto);',
    ]) expect(mentionsRandomUuid(src)).toBe(true);
    expect(mentionsRandomUuid('// randomUUID в комментарии\nconst x = 1;')).toBe(false);
  });

  const callers = sourceFiles()
    .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), 'utf8') }))
    .filter(({ rel, src }) => mentionsRandomUuid(src) && !isServer(rel, src))
    .map(({ rel }) => rel);

  it('каждый клиентский вызов — в записанном файле со своей проверкой', () => {
    expect(callers.filter((rel) => !(rel in CLIENT_GUARDED))).toEqual([]);
  });

  it('запись без вызова снимается (самоустаревание)', () => {
    expect(Object.keys(CLIENT_GUARDED).filter((rel) => !callers.includes(rel))).toEqual([]);
  });
});
