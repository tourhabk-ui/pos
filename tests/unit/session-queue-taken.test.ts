/**
 * Сторож очереди находок на старте сессии: занятое обязано быть НАЗВАНО.
 *
 * ── Что случилось (14.09) ─────────────────────────────────────────────────
 *
 * Владелец держал в репозитории четыре параллельные сессии. Две находки —
 * #1883 и #1889 — были сделаны ДВАЖДЫ, разными сессиями, в один день. У
 * #1883 обе работы дошли до готовых PR; вмёржена одна, вторая выброшена.
 *
 * Причина не в невнимательности исполнителя, а в РАЗДАЧЕ: хук
 * `.claude/hooks/open-issues.sh` выдавал всем четверым один и тот же список
 * со словами «разобрать до новой работы», и занятая находка выглядела в нём
 * ровно как свободная. Правило 08.09 «сначала занять, потом чинить»
 * существовало, но держалось на том, что исполнитель вспомнит сходить в PR
 * руками — то есть на памяти, а не на механизме.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Не текст хука, а его ПОВЕДЕНИЕ: разбор вынимается из скрипта и гоняется на
 * фикстурах. Проверка, сверяющая только формулировки, зеленела бы и после
 * того, как логика отвалилась.
 *
 * Три исхода (§4.0) здесь настоящие: «свободно», «занято PR #N» и «занятость
 * проверить не удалось». Третий не равен первому — молчание о непроверенной
 * занятости и есть та самая раздача, которая стоила вечера.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const HOOK = readFileSync(join(ROOT, '.claude/hooks/open-issues.sh'), 'utf-8');

/** Разбор очереди — python-блок внутри скрипта. Вынимаем ровно его. */
function extractParser(): string {
  const start = HOOK.indexOf("<<'PYQUEUE'");
  expect(start, 'python-блок разбора очереди исчез из хука').toBeGreaterThan(-1);
  const from = HOOK.indexOf('\n', start) + 1;
  const end = HOOK.indexOf('\nPYQUEUE', from);
  expect(end, 'разделитель PYQUEUE не закрыт').toBeGreaterThan(from);
  return HOOK.slice(from, end);
}

let dir = '';
let parser = '';

const ISSUE = (number: number, title: string) => ({
  number,
  title,
  created_at: new Date().toISOString(),
  labels: [{ name: 'evo' }],
});

/** Прогон разбора на фикстурах: что увидит сессия на старте. */
function run(issues: unknown, pulls: unknown | null): string {
  const i = join(dir, `i-${Math.random().toString(36).slice(2)}.json`);
  const p = join(dir, `p-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(i, JSON.stringify(issues));
  // null — ответ по PR не пришёл вовсе (curl упал): файл пуст, как в хуке.
  writeFileSync(p, pulls === null ? '' : JSON.stringify(pulls));
  return execFileSync('python3', [join(dir, 'parser.py'), i, p], { encoding: 'utf-8' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-'));
  parser = extractParser();
  writeFileSync(join(dir, 'parser.py'), parser);
});

describe('занятая находка названа занятой', () => {
  it('issue с открытым PR уходит в отдельный список с номером PR', () => {
    const out = run(
      [ISSUE(1883, 'Кузьмич выдумывает километраж'), ISSUE(1885, 'Сбои авиаперелётов')],
      [{ number: 1891, title: 'Guard километража (#1883)', body: '' }],
    );
    expect(out).toMatch(/ЗАНЯТО ДРУГИМИ/);
    expect(out).toMatch(/#1883[\s\S]*открытый PR #1891/);
  });

  it('занятое НЕ прячется: находка остаётся видимой', () => {
    // Спрятанная находка неотличима от несуществующей, а PR может быть
    // брошен или касаться issue краем. Решение «всё равно берусь» — за
    // человеком, но принимается зряче.
    const out = run([ISSUE(1883, 'Выдуманный километраж')], [
      { number: 1891, title: 'fix', body: 'Closes #1883' },
    ]);
    expect(out).toMatch(/1883/);
    expect(out).toMatch(/Выдуманный километраж/);
  });

  it('ссылка в ТЕЛЕ PR считается так же, как в заголовке', () => {
    const out = run([ISSUE(1889, 'Ключ к брони')], [
      { number: 1891, title: 'Доставка ключа', body: 'Закрывает #1889 полностью.' },
    ]);
    expect(out).toMatch(/открытый PR #1891/);
  });

  it('свободная находка занятой не объявляется', () => {
    const out = run([ISSUE(1885, 'Сбои авиаперелётов')], [
      { number: 1891, title: 'Совсем про другое (#1883)', body: '' },
    ]);
    expect(out).not.toMatch(/ЗАНЯТО ДРУГИМИ/);
    expect(out).toMatch(/1885/);
  });

  it('PR не занимает сам себя собственным номером', () => {
    // Иначе любой PR, упомянувший свой номер в теле, «занял» бы issue с тем
    // же числом — чужую и ни при чём.
    const out = run([ISSUE(1891, 'Находка с номером как у PR')], [
      { number: 1891, title: 'PR #1891', body: 'см. #1891' },
    ]);
    expect(out).not.toMatch(/ЗАНЯТО ДРУГИМИ/);
  });
});

describe('третий исход: занятость не проверена', () => {
  it('ответ по PR не пришёл — так и сказано, а не «все свободны»', () => {
    const out = run([ISSUE(1885, 'Сбои авиаперелётов')], null);
    expect(out).toMatch(/ЗАНЯТОСТЬ НЕ ПРОВЕРЕНА/);
    expect(out).toMatch(/НЕ «все свободны»/);
  });

  it('ответ по PR не разобрался — то же самое', () => {
    const i = join(dir, 'i-broken.json');
    const p = join(dir, 'p-broken.json');
    writeFileSync(i, JSON.stringify([ISSUE(1885, 'Сбои')]));
    writeFileSync(p, 'не json вовсе');
    const out = execFileSync('python3', [join(dir, 'parser.py'), i, p], { encoding: 'utf-8' });
    expect(out).toMatch(/ЗАНЯТОСТЬ НЕ ПРОВЕРЕНА/);
  });

  it('пустая очередь при непрочитанных PR тоже говорит о непроверенности', () => {
    const out = run([], null);
    expect(out).toMatch(/Открытых issues нет/);
    expect(out).toMatch(/ЗАНЯТОСТЬ НЕ ПРОВЕРЕНА/);
  });

  it('нечитаемая очередь не выдаётся за пустую', () => {
    const i = join(dir, 'i-bad.json');
    const p = join(dir, 'p-bad.json');
    writeFileSync(i, '{ не список');
    writeFileSync(p, '[]');
    const out = execFileSync('python3', [join(dir, 'parser.py'), i, p], { encoding: 'utf-8' });
    expect(out).toMatch(/ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА/);
    expect(out).not.toMatch(/Открытых issues нет/);
  });
});

describe('область сессии не угадывается', () => {
  it('хук говорит, что области не знает, и велит спросить', () => {
    const out = run([ISSUE(1885, 'Сбои авиаперелётов')], []);
    expect(out).toMatch(/Область этой сессии хук не знает и не угадывает/);
  });

  it('в разборе нет вывода области из имени ветки', () => {
    // Угаданная граница хуже отсутствующей: на неё положатся. Имя ветки
    // придумывает не человек, и слова в нём областью не являются.
    expect(parser).not.toMatch(/branch|HEAD|rev-parse/i);
  });
});

describe('хук не может промолчать', () => {
  it('пустой вывод разбора превращается в явный отказ, а не в тишину', () => {
    // Так уже случилось: первая редакция правки передавала ответы через
    // окружение, упёрлась в «Argument list too long» — и очередь пришла
    // ПУСТОЙ, то есть поломка притворилась «issues нет».
    expect(HOOK).toMatch(/if \[ -z "\$\{OUT\/\/\[\[:space:\]\]\/\}" \]/);
    expect(HOOK).toMatch(/разбор вернул пустоту/);
  });

  it('ответы уходят в разбор файлами, а не окружением или argv', () => {
    expect(HOOK).toMatch(/mktemp -d/);
    expect(HOOK).not.toMatch(/BODY="\$BODY" PULLS="\$PULLS"/);
  });

  it('временный каталог убирается за собой', () => {
    expect(HOOK).toMatch(/trap 'rm -rf "\$TMPDIR_Q"' EXIT/);
  });

  it('отказ любой из двух загрузок назван вслух', () => {
    expect(HOOK).toMatch(/ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: GitHub API недоступен/);
    expect(HOOK).toMatch(/ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: нет GITHUB_TOKEN/);
  });
});
