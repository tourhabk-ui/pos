/**
 * Smoke ходит только по страницам, которые в приложении есть.
 *
 * Ночной прогон по проду падал шесть ночей подряд (04–09.08) на двух вещах, и
 * обе оказались не регрессией прода, а устаревшим ожиданием теста:
 *
 *   1. `page.goto('/auth')` — страницы `/auth` не существует и не существовало.
 *      Это сегмент с одним layout; вход живёт на `/auth/login`, туда же уводит
 *      middleware. Прод честно отдавал 404, а smoke считал это поломкой входа.
 *   2. Заголовок главной проверялся по словоформе «Камчатка», тогда как в
 *      заголовке стоит «по Камчатке». Падеж.
 *
 * Первое ловится статически — за секунду, на каждом PR, а не шестью ночами
 * прод-прогонов. Второе статически не поймать, но оно и не про адреса.
 *
 * Ценность не в самих двух правках, а в том, что сторож, который кричит
 * впустую, перестают читать. Шесть красных ночей подряд обесценивают седьмую,
 * настоящую.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = readFileSync(join(process.cwd(), 'test/e2e/smoke.spec.ts'), 'utf-8');

/** Все `page.goto('...')` из smoke-спеки. */
function gotoPaths(src: string): string[] {
  const out: string[] = [];
  const re = /page\.goto\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * Есть ли у пути страница в App Router.
 *
 * Проверка нарочно грубая и щадящая: ищем `page.tsx`/`page.ts` по прямому
 * пути. Динамические сегменты и группы маршрутов сюда не попадают — в smoke
 * их и нет, а если появятся, лучше пропустить проверку, чем обвинить живой
 * маршрут. Ложное «страницы нет» на существующей странице дороже пропуска.
 */
function hasPage(urlPath: string): boolean {
  const clean = urlPath.split('?')[0].split('#')[0];
  const rel = clean === '/' ? 'app' : join('app', clean);
  return ['page.tsx', 'page.ts', 'page.jsx', 'page.js']
    .some((f) => existsSync(join(process.cwd(), rel, f)));
}

describe('адреса smoke существуют в приложении', () => {
  const paths = gotoPaths(SPEC);

  it('в спеке вообще есть переходы — иначе проверять нечего', () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it('каждый путь ведёт на существующую страницу', () => {
    const missing = paths.filter((p) => !hasPage(p));
    expect(
      missing,
      `smoke ходит на несуществующие страницы: ${missing.join(', ')}. ` +
      'Прод отдаст 404, и ночной прогон будет красным без всякой регрессии.',
    ).toEqual([]);
  });

  it('вход проверяется на /auth/login, а не на сегменте /auth', () => {
    // Именно эта строка стоила шести красных ночей.
    expect(paths).toContain('/auth/login');
    expect(paths, 'вернулся голый /auth — страницы с таким адресом нет').not.toContain('/auth');
  });
});

describe('заголовок главной проверяется по основе, а не по словоформе', () => {
  it('регулярка заголовка переживает склонение', () => {
    const m = /toHaveTitle\(([^)]+)\)/.exec(SPEC);
    expect(m, 'проверка заголовка главной исчезла').not.toBeNull();
    const pattern = m![1];
    // «Камчатка» не совпадёт с «по Камчатке» — основа совпадёт с обеими.
    expect(pattern, 'словоформа вместо основы — тест снова упадёт на падеже')
      .not.toMatch(/Камчатка/);
    expect(pattern).toMatch(/Камчатк[^а]/);
  });

  it('регулярка знает нынешнее имя платформы', () => {
    const layout = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf-8');
    const title = /title:\s*'([^']+)'/.exec(layout)?.[1] ?? '';
    expect(title, 'заголовок главной не прочитался').not.toBe('');
    const m = /toHaveTitle\(\/([^/]+)\/i\)/.exec(SPEC);
    expect(m).not.toBeNull();
    // Настоящий заголовок обязан проходить проверку — иначе она сторожит не то.
    expect(new RegExp(m![1], 'i').test(title)).toBe(true);
  });
});
