/**
 * Защита от подделки межсайтового запроса держится на самой куке.
 *
 * `auth_token` — httpOnly-кука, и middleware принимает её наравне с
 * заголовком. Значит браузер приложит её к любому запросу, который чужая
 * страница отправит на наш домен, — если ей это позволит атрибут `SameSite`.
 * При `lax` кросс-сайтовый POST/PUT/DELETE куку НЕ несёт; это и есть рабочая
 * защита платформы.
 *
 * Двойная отправка токена (`lib/middleware/csrf.ts`) была написана и не
 * подключена ни к одному из 676 маршрутов: выдавался токен, который никто
 * никогда не проверял. Удалена 22.08.2026 — механизм, который читается как
 * защита и ею не является, хуже отсутствия. Настоящую защиту с тех пор держит
 * этот сторож: молчаливая потеря `sameSite` откроет дыру, а выглядеть это
 * будет как обычная правка настроек куки.
 *
 * Что сторож НЕ покрывает: атакующего, владеющего соседним поддоменом (для
 * `lax` он «свой»), и изменяющие состояние GET-маршруты за куки-авторизацией —
 * при `lax` кука уходит с переходом по ссылке. На 22.08.2026 таких маршрутов
 * с выгодой для атакующего нет: импорт закрыт `CRON_SECRET`, настройки
 * оператора создают собственную же строку, карточка места считает просмотры.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Каждая установка `auth_token` вместе с телом её опций. */
function issuanceSites(): Array<{ file: string; options: string }> {
  const sites: Array<{ file: string; options: string }> = [];
  for (const file of [...walk('app'), ...walk('lib')]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/cookies\.set\(\s*['"]auth_token['"][\s\S]{0,600}?\n\s*\}\)/g)) {
      sites.push({ file, options: m[0] });
    }
  }
  return sites;
}

describe('кука авторизации', () => {
  const sites = issuanceSites();

  it('места выдачи вообще находятся — иначе сторож сторожит пустоту', () => {
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it('у каждой выдачи задан SameSite, и он не None', () => {
    const bad = sites.filter(s => !/sameSite:\s*'(lax|strict)'/.test(s.options));
    expect(bad.map(s => s.file), 'sameSite lax или strict обязателен').toEqual([]);
  });

  it('кука недоступна скриптам страницы', () => {
    const bad = sites.filter(s => !/httpOnly:\s*true/.test(s.options));
    expect(bad.map(s => s.file), 'httpOnly обязателен').toEqual([]);
  });

  it('в проде кука уходит только по HTTPS', () => {
    const bad = sites.filter(s => !/secure:/.test(s.options));
    expect(bad.map(s => s.file), 'secure обязателен').toEqual([]);
  });
});

describe('двойная отправка токена не возвращается недоделанной', () => {
  it('модуля CSRF нет — вместе с эндпоинтом, выдававшим непроверяемый токен', () => {
    expect(fs.existsSync(path.join(ROOT, 'lib/middleware/csrf.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/api/csrf-token/route.ts'))).toBe(false);
  });

  it('если двойную отправку вернут, у неё будет и проверяющая сторона', () => {
    // Вернуть можно — но выдача токена без единой проверки это не защита, а
    // её вид. Условие: появился `withCsrfProtection` — значит он где-то
    // применён, вне собственного файла и вне тестов.
    const users = [...walk('app'), ...walk('lib')]
      .filter(f => f !== 'lib/middleware/csrf.ts')
      .filter(f => /withCsrfProtection|csrfMiddleware/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')));
    const declared = fs.existsSync(path.join(ROOT, 'lib/middleware/csrf.ts'));
    if (declared) expect(users.length, 'CSRF объявлен, но нигде не применён').toBeGreaterThan(0);
    else expect(users).toEqual([]);
  });
});
