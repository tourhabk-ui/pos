/**
 * Ни один наш прогон не шлёт настоящий SOS в живой приёмник.
 *
 * ── Случай 02.09 ───────────────────────────────────────────────────────────
 *
 * Владелец: «мне нужно понять, кто шлёт SOS». Перепись sos-census ответила:
 * два сигнала за 90 дней, оба curl/8.5.0, оба с адресов Azure, без единого
 * поля. Прогоны perimeter-smoke.yml — 06:05:05Z и 11:44:37Z; сигналы —
 * 06:05:14Z и 11:44:51Z. Слали мы сами: smoke-тест периметра бил `POST {}` в
 * /api/safety/sos, ожидая 400, а приёмник по замыслу принимает пустое тело —
 * 200, строка в базе, тревога в Telegram, Watchdog зовёт 112.
 *
 * Правило одно: проверять доступность приёмника SOS можно только способом,
 * который сигнала не создаёт. GET у роута не реализован — 405 приходит из
 * самого роута, Edge пропустил, сигнала нет по построению.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const strip = (s: string) => s.replace(/^[ \t]*#.*$/gm, '');

describe('perimeter-smoke.sh', () => {
  const sh = strip(read('scripts/ci/perimeter-smoke.sh'));

  it('SOS проверяется GET, а не POST', () => {
    expect(sh).toMatch(/row "GET {2}\/api\/safety\/sos/);
    expect(sh).not.toMatch(/-X POST[^\n]*\/api\/safety\/sos/);
  });

  it('и в фикстуре сторожа периметра ответ — 405, а не выдуманные 400', () => {
    // Прежняя фикстура закрепляла ВЕРУ автора («хендлер ответит 400»), а не
    // поведение приёмника. Тест, проверяющий согласие с самим собой.
    expect(read('tests/unit/perimeter-smoke.test.ts')).toMatch(/'\/api\/safety\/sos': '405'/);
  });
});

describe('workflows и CI-скрипты', () => {
  const files: string[] = [];
  for (const dir of ['.github/workflows', 'scripts/ci']) {
    for (const f of readdirSync(join(ROOT, dir))) files.push(join(dir, f));
  }

  it('нигде нет POST в /api/safety/sos', () => {
    for (const f of files) {
      const body = strip(read(f));
      // Один и тот же запрос ловится в любой записи: curl -X POST … sos,
      // fetch(…sos, {method:'POST'}), и наоборот.
      const post = /-X\s*POST[^\n]*\/api\/safety\/sos|\/api\/safety\/sos[^\n]*-X\s*POST|method:\s*['"]POST['"][^\n]*\/api\/safety\/sos|\/api\/safety\/sos[^\n]*method:\s*['"]POST['"]/;
      expect(body, `${f}: POST в живой приёмник SOS`).not.toMatch(post);
    }
  });
});
