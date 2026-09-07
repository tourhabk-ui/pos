/**
 * Сторож: «не дождались сборки» — не успех, когда эндпоинт едет тем же коммитом.
 *
 * ── Замер 07.09 ────────────────────────────────────────────────────────────
 *
 * Две пробы (разбор справочника маршрутов и retrieval Кузьмича) уехали на прод
 * вместе со своими эндпоинтами. Шаг ожидания отработал 28,3 минуты — то есть
 * исчерпал терпение (50 попыток × 30 с) — и отчитался УСПЕХОМ, после чего обе
 * получили HTTP 404.
 *
 * Красный был, но лживый по причине: в логе он выглядел отказом прода, а на
 * деле сборка ещё ехала. Вызов модели при этом потрачен впустую.
 *
 * Разница, которую держит этот сторож:
 *
 *   эндпоинт живёт давно  → «не дождались» = замер на чужой сборке, полезен,
 *                            прогон продолжается (так было и остаётся);
 *   эндпоинт едет с нами  → «не дождались» = спрашивать нечего, красный.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SH = readFileSync(join(process.cwd(), 'scripts/wait-for-deploy.sh'), 'utf8');
const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => readFileSync(join(WF_DIR, f), 'utf8');

describe('скрипт различает два случая', () => {
  it('строгий режим краснеет и называет причину', () => {
    expect(SH).toContain('REQUIRE_FRESH');
    expect(SH).toMatch(/REQUIRE_FRESH:-0.*\n?.*::error::/s);
    expect(SH).toContain('exit 1');
  });

  it('мягкий режим остаётся: замер на чужой сборке всё ещё полезен', () => {
    // Ломать его нельзя — по нему живут диагностики давних эндпоинтов.
    expect(SH).toContain('прогон идёт на том коде, что есть');
    expect(SH).toMatch(/что есть \(прод отдаёт[^\n]*\n?exit 0/);
  });

  it('терпения хватает на наблюдавшуюся выкладку', () => {
    // 28 минут — замеренный факт 07.09; 25 минут прежнего потолка мало.
    const m = SH.match(/ATTEMPTS="\$\{ATTEMPTS:-(\d+)\}"/);
    const sleep = SH.match(/SLEEP="\$\{SLEEP:-(\d+)\}"/);
    expect(m, 'потолок попыток не найден').not.toBeNull();
    const minutes = (Number(m![1]) * Number(sleep![1])) / 60;
    expect(minutes).toBeGreaterThanOrEqual(30);
  });
});

describe('пробы, чей эндпоинт едет с ними, ждут строго', () => {
  // Замер 07.09: эти три workflow привезли свои эндпоинты тем же коммитом.
  // Список может РАСТИ (у новой пробы то же свойство), но ни один из
  // перечисленных не вправе вернуться к мягкому ожиданию.
  const SHIP_THEIR_ENDPOINT = [
    'route-analysis.yml',
    'retrieval-probe.yml',
    'alerts-census.yml',
  ];

  for (const f of SHIP_THEIR_ENDPOINT) {
    it(`${f}: не дождались сборки — красный`, () => {
      expect(files, `${f} исчез из workflows`).toContain(f);
      const src = read(f);
      expect(src).toContain('run: bash scripts/wait-for-deploy.sh');
      expect(src).toMatch(/REQUIRE_FRESH:\s*'1'/);
    });
  }
});
