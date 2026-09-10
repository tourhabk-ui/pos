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

/**
 * ── #1762, 10.09 ───────────────────────────────────────────────────────────
 *
 * Пока маркер прода отдаёт `commit: unknown`, исход «точный sha» недостижим,
 * и всё держится на «built_at новее пуша». Но образ ПРЕДЫДУЩЕГО коммита,
 * собранный после нашего пуша, тоже новее пуша: мерж 00:02:34, built_at
 * 00:06:44 — и старый контейнер дважды за час сошёл за свежий
 * (safety-ledger-check run 8, prod-check run 46). Поэтому правило требует
 * запас не меньше минимального времени сборки и печатает разницу.
 */
describe('сборка новее пуша — только с запасом на время сборки (#1762)', () => {
  it('запас задан переменной и по умолчанию не меньше десяти минут', () => {
    const m = SH.match(/MIN_BUILD_SECONDS="\$\{MIN_BUILD_SECONDS:-(\d+)\}"/);
    expect(m, 'MIN_BUILD_SECONDS не найден').not.toBeNull();
    // Ранние замеры сборки — около двенадцати минут, 07.09 — 26; быстрее
    // десяти не бывало. Ниже — снова «четыре минуты сошли за сборку».
    expect(Number(m![1])).toBeGreaterThanOrEqual(600);
  });

  it('deploy.yml держит тот же запас, что и скрипт — одно правило, не два (§12)', () => {
    const script = SH.match(/MIN_BUILD_SECONDS="\$\{MIN_BUILD_SECONDS:-(\d+)\}"/);
    const deploy = read('deploy.yml').match(/^\s*MIN_BUILD_SECONDS=(\d+)\s*$/m);
    expect(deploy, 'deploy.yml не задаёт MIN_BUILD_SECONDS').not.toBeNull();
    expect(Number(deploy![1])).toBe(Number(script![1]));
    expect(read('deploy.yml')).toMatch(/\[ "\$AHEAD" -ge "\$MIN_BUILD_SECONDS" \]/);
    expect(read('deploy.yml')).not.toMatch(/\[ "\$BUILT_EPOCH" -ge "\$NEED_EPOCH" \]/);
  });

  it('правило сравнивает разницу с запасом, а не built_at с пушем напрямую', () => {
    expect(SH).toMatch(/AHEAD=\$\(\(BT - NEED\)\)/);
    expect(SH).toMatch(/\[ -n "\$AHEAD" \] && \[ "\$AHEAD" -ge "\$MIN_BUILD_SECONDS" \]/);
    expect(SH).not.toMatch(/\[ "\$BT" -ge "\$NEED" \]/);
  });

  it('разница «сборка минус пуш» печатается в каждой строке ожидания и в исходе', () => {
    // Пункт 3 находки: читающий видит, тот ли образ, без арифметики в голове.
    expect(SH).toMatch(/AHEAD_TXT="built_at минус пуш = \$\{AHEAD\}с"/);
    expect(SH).toMatch(/ещё не доехало:[^\n]*\$AHEAD_TXT/);
    expect(SH).toMatch(/прод на сборке новее нашего коммита:[^\n]*\$AHEAD_TXT/);
    expect(SH).toMatch(/прод на нашем коммите[^\n]*\$AHEAD_TXT/);
  });

  it('без времени пуша (workflow_dispatch) исход 2 не срабатывает вовсе', () => {
    // AHEAD пуст, когда NEED_AFTER не задан: тогда судит только точный sha.
    expect(SH).toMatch(/AHEAD=""; AHEAD_TXT="built_at \$BT, время пуша не задано"/);
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
