/**
 * Сторож привилегированных workflow: чужой код не исполняется нашим токеном.
 *
 * actions/untrusted-checkout/high — первая находка, которую CodeQL напечатал
 * по языку `actions` (23.08.2026). До этого дня язык не запрашивали, и
 * проверка workflow не шла вовсе: 104 файла, 100 из них с `${{ }}`, и ноль
 * находок — не потому что чисто, а потому что не смотрели.
 *
 * Фигура находки: `workflow_run` — привилегированный триггер. Джоб получает
 * секреты репозитория и права на запись, потом делает checkout ветки, у
 * которой упал CI, и запускает над ней агента.
 *
 * Здесь закреплено правило: у джоба на privileged-триггере должно стоять
 * условие про ИСТОЧНИК события. Отсутствие `repository:` у checkout защитой
 * не считается — это защита на отсутствии строки, которую однажды допишут.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

/** Триггеры, дающие джобу секреты и права репозитория при чужом коде. */
const PRIVILEGED = /^\s*(workflow_run|pull_request_target):/m;

/** Проверка источника: ран пришёл из нашего же репозитория, не из форка. */
const SOURCE_CHECK = /head_repository\.full_name\s*==\s*github\.repository/;

describe('привилегированные триггеры проверяют источник', () => {
  const privileged = files.filter((f) => PRIVILEGED.test(readFileSync(join(WF_DIR, f), 'utf8')));

  it('такие workflow в репозитории есть — иначе сторож проверяет пустоту', () => {
    // Без этого тест был бы зелёным и бессмысленным (§4.0: проверка, которой
    // нечего проверять, обязана сказать это вслух, а не молчать).
    expect(privileged.length).toBeGreaterThan(0);
  });

  it('checkout по ссылке ИЗ СОБЫТИЯ — только после проверки источника', () => {
    // Опасен не всякий checkout, а тот, чья ссылка выведена из события:
    // именно тогда в рабочий каталог попадает чужой код.
    //
    // deploy.yml тоже сидит на workflow_run, но берёт `ref: main` —
    // фиксированную ссылку, — и триггер у него сужен `branches: [main]`.
    // Чужому коду там взяться неоткуда, и CodeQL его не отмечал: правило
    // судит по источнику ссылки, а не по наличию слова checkout. Сторож
    // должен судить так же, иначе он краснеет на верном коде и его выключат.
    const EVENT_REF = /ref:\s*\$\{\{[^}]*github\.event\.(workflow_run\.head_|pull_request\.head\.)/;
    const offenders = privileged.filter((f) => {
      const src = readFileSync(join(WF_DIR, f), 'utf8');
      return EVENT_REF.test(src) && !SOURCE_CHECK.test(src);
    });
    expect(
      offenders,
      `checkout по ссылке из события без проверки источника: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('ci-sweeper: условие про источник стоит ПЕРВЫМ', () => {
    // Порядок важен для читающего человека: первое, что видно в условии, —
    // откуда пришёл ран, а не почему он упал.
    const src = readFileSync(join(WF_DIR, 'ci-sweeper.yml'), 'utf8');
    const cond = src.slice(src.indexOf('if: |'), src.indexOf('runs-on:'));
    const lines = cond.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l !== 'if: |');
    expect(lines[0]).toMatch(SOURCE_CHECK);
  });
});
