/**
 * Карточка места: отказ называется отказом, а текст ошибки базы остаётся в логе.
 *
 * ── Что нашлось обходом экранов туриста 26.09 ────────────────────────────
 *
 * Живой запрос с сессией туриста на локальном приложении, схема — baseline
 * прода плюс все миграции:
 *
 *   POST /api/places/<ark_id>/reviews  →  HTTP 500
 *   {"success":false,"error":"record \"new\" has no field \"operator_id\""}
 *
 * Турист, нажавший «Отправить отзыв», читал на экране внутреннее устройство
 * базы. Ту же болезнь имели соседи по семейству: `GET /api/places/[id]`
 * (карточка зовёт его при каждом открытии) и `GET /api/places/[id]/gpx`
 * (файл точки, который человек скачивает в поле) отдавали `err.message`
 * наружу, а в лог не писали ничего — то есть причина не оседала НИГДЕ.
 *
 * Правило то же, что у публичного каталога (`catalog-error-honesty`), и здесь
 * оно держится для всего семейства `app/api/places/**`:
 *
 *   1. наружу — нейтральный русский текст, без `err.message`;
 *   2. в лог — SQLSTATE (`code`) и то, о чём спрашивали: молчащий catch
 *      превращает поломку в «данных нет» (§4.0).
 *
 * Сторож ходит по КАТАЛОГУ, а не по списку файлов: новый роут места,
 * отдающий текст ошибки наружу, краснеет сам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PLACES_API = join(process.cwd(), 'app/api/places');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

/** Комментарии вырезаны: в них причина как раз описана — и должна быть. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTES = routeFiles(PLACES_API).map((path) => ({
  rel: path.replace(process.cwd() + '/', ''),
  code: stripComments(readFileSync(path, 'utf-8')),
}));

describe('роуты места не отдают наружу текст ошибки базы', () => {
  it('роуты найдены (пустой обход — это отказ, а не успех)', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(5);
  });

  for (const { rel, code } of ROUTES) {
    it(`${rel}: err.message не попадает в ответ`, () => {
      // Ответ клиенту: NextResponse.json({... error: <текст> ...}) либо
      // new NextResponse(<текст>). Ищем в обоих формах передачу message
      // ошибки в ТЕЛО ответа. Лог с message — разрешён и нужен.
      const lines = code.split('\n');
      const offenders: string[] = [];
      lines.forEach((line, i) => {
        const isLog = /console\.(error|warn|info|log)/.test(line);
        if (isLog) return;
        const inResponse = /NextResponse\.(json|redirect)?|new NextResponse/.test(line);
        const carriesErrorText =
          /\berror\s*:\s*(message|msg|e\.message|err\.message|error\.message)\b/.test(line) ||
          /new NextResponse\(\s*(message|msg|e\.message|err\.message)\b/.test(line);
        if (carriesErrorText && (inResponse || /\berror\s*:/.test(line))) {
          offenders.push(`${i + 1}: ${line.trim()}`);
        }
      });
      expect(offenders, `${rel} отдаёт текст ошибки наружу:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('катастрофические пути пишут SQLSTATE в лог', () => {
    // Три роута, чей отказ видит турист: карточка, отзыв, файл точки.
    const mustLogSqlstate = [
      'app/api/places/[id]/route.ts',
      'app/api/places/[id]/reviews/route.ts',
      'app/api/places/[id]/gpx/route.ts',
    ];
    for (const rel of mustLogSqlstate) {
      const entry = ROUTES.find((r) => r.rel === rel);
      expect(entry, `${rel} не найден — переименован? сторож обязан знать об этом`).toBeTruthy();
      expect(entry!.code, `${rel} не пишет SQLSTATE в лог`).toMatch(/sqlstate/i);
    }
  });
});
