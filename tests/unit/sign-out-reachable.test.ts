/**
 * «Выйти» достижим из кабинета, профиля и «Ещё» — и реализован один раз.
 *
 * Повод (#1778, прогулка туристом 10.09): выхода из аккаунта не было НИГДЕ.
 * `signOut()` в AuthContext существовал с самого начала — его просто никто
 * не звал с экрана, и сессию можно было закончить только чисткой cookie.
 *
 * Сторож держит две вещи: кнопка стоит на трёх поверхностях, и запрос к
 * /api/auth/signout шлёт только AuthContext (вторая реализация одного
 * действия разъезжается — урок SOS, #887).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const BUTTON = 'components/auth/SignOutButton.tsx';
const SURFACES = [
  'components/layout/HubLayout.tsx',          // шапка кабинета любой роли
  'app/hub/tourist/profile/_ProfileClient.tsx', // профиль туриста
  'app/menu/page.tsx',                          // «Ещё» с телефона
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', '_archive'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('«Выйти» — одна реализация', () => {
  it('кнопка зовёт signOut() из AuthContext, а не ходит в API сама', () => {
    const src = read(BUTTON);
    expect(src).toMatch(/useAuth\(\)/);
    expect(src).toMatch(/await signOut\(\)/);
    expect(src).not.toMatch(/fetch\([^)]*signout/);
  });

  it('кнопка молчит для гостя и пока вход не выяснен', () => {
    const src = read(BUTTON);
    expect(src).toMatch(/if \(!user \|\| isLoading\) return null/);
  });

  it('POST /api/auth/signout шлёт только AuthContext', () => {
    const callers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'contexts')), ...walk(join(ROOT, 'hooks'))]
      .filter((f) => !f.includes(`${join('app', 'api')}`))
      .map((f) => relative(ROOT, f))
      .filter((p) => /fetch\([^)]*\/api\/auth\/signout/.test(readFileSync(join(ROOT, p), 'utf-8')));
    expect(callers).toEqual(['contexts/AuthContext.tsx']);
  });
});

describe('«Выйти» стоит на трёх поверхностях', () => {
  it.each(SURFACES)('%s рендерит SignOutButton', (path) => {
    expect(read(path)).toMatch(/<SignOutButton\b/);
  });
});
