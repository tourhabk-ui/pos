/**
 * Нет CRON_SECRET — прогон КРАСНЫЙ, а не зелёный «пропуск».
 *
 * ── Откуда правило (аудит 15.10, находка P2-09, дорожная карта 1.3) ───────
 *
 * Шаг, который зовёт `/api/cron/*`, начинается проверкой секрета. В десятках
 * workflow ветка «секрет пуст» была `echo "CRON_SECRET not set"; exit 0`.
 * Потеряй или переименуй секрет репозитория — и safety-heartbeat, watchdog,
 * health и остальные идут ровным рядом зелёных галочек, не вызвав ни одного
 * эндпоинта. Это §4.0 дословно: третий исход («не смог») выдан за первый
 * («хорошо»). Ровно на такой ряд смотрел владелец 17.08, спрашивая, почему
 * молчит канал дайджеста (шапка шага в cron-scout-digest.yml).
 *
 * ── Что судит сторож ──────────────────────────────────────────────────────
 *
 * Не форму строки, а смысл (§4 «сторож судит поведение»): YAML разбирается,
 * для каждого шага собирается окружение (workflow → job → step), и имена,
 * в которые положен `secrets.CRON_SECRET`, становятся «секретными». В тексте
 * `run:` ищется проверка их пустоты в любой из форм оболочки
 * (`if [ -z … ]; then … fi`, `[ -z … ] && …`, `[ -n … ] || …`, `if [ -n … ]`
 * без ветки else), вынимается ВЕТКА, которая исполнится при пустом секрете,
 * и судится её исход: красная — только если она кончается `exit <не ноль>`.
 * `exit 0`, голый `exit`, `continue` и «ничего» (шаг идёт дальше, работа
 * пропущена) — зелёный пропуск, нарушение. Условие `if:` у шага по секрету —
 * тоже пропуск: шаг тихо не исполнится.
 *
 * Полноту разбора держит перепись: каждая строка-проверка, где секрет стоит
 * внутри `[ … ]`/`test`, обязана быть узнана разбором. Новая форма, которую
 * разбор не понимает, краснеет здесь, а не проскальзывает мимо.
 *
 * Исключения — самоустаревающим списком с причиной: исключение без
 * нарушения краснеет (убери запись), а нарушение в исключении обязано быть
 * громким (`::warning::`/`::error::`), а не немым.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = process.cwd();
const WF_DIR = '.github/workflows';

// ── Разбор ────────────────────────────────────────────────────────────────

type Verdict =
  /** ветка пустого секрета кончается exit <не ноль> */
  | 'red'
  /** exit 0 / голый exit / continue / return */
  | 'green'
  /** выхода нет: шаг идёт дальше без секрета, работа пропущена */
  | 'fallthrough'
  /** условие `if:` шага или задачи по секрету — шаг тихо не исполнится */
  | 'step-skip'
  /**
   * секрет необязателен: `[ -n S ] && AUTH=(…)` — при пустом работа идёт
   * без заголовка, и прод сам отвечает 401 (prod-check печатает код в
   * аннотацию). Это не пропуск работы, а не проверка вовсе.
   */
  | 'optional';

interface Check {
  file: string;
  job: string;
  step: string;
  verdict: Verdict;
  /** в ветке есть ::error:: или ::warning:: — пропуск виден в аннотациях */
  loud: boolean;
  branch: string;
}

const SECRET_IN_EXPR = /\$\{\{[^}]*\bsecrets\.CRON_SECRET\b[^}]*\}\}/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Имена переменных окружения, в которые положен secrets.CRON_SECRET. */
function secretNames(...envs: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const env of envs) {
    if (!isObj(env)) continue;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && SECRET_IN_EXPR.test(v)) out.add(k);
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ссылка на секрет в оболочке: $N, ${N}, ${N:-…}, ${{ secrets.CRON_SECRET }}. */
function refPattern(names: Set<string>): string {
  const alts = [...names].map((n) => `\\$\\{?${esc(n)}(?::?-[^}"]*)?\\}?(?![A-Za-z0-9_])`);
  alts.push('\\$\\{\\{\\s*secrets\\.CRON_SECRET\\s*\\}\\}');
  return `(?:${alts.join('|')})`;
}

/**
 * Та же строка той же длины, где содержимое кавычек и комментарии заменены
 * пробелами-заглушками: структура (if/then/fi, exit, &&) ищется по ней, а
 * позиции совпадают с исходником — текст ветки берётся из оригинала.
 */
function structural(src: string): string {
  const out = src.split('');
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (lineStart && /\s/.test(c)) { i++; continue; }
    if (lineStart && c === '#') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    lineStart = false;
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === '\\') { out[i] = ' '; i++; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Исход ветки по её структурному тексту. */
function judgeBranch(struct: string): Verdict {
  const exits = [...struct.matchAll(/(?<![\w-])(exit|return|continue)(?![\w-])[ \t]*([^\s;}&|]*)/g)];
  if (exits.length === 0) return 'fallthrough';
  const nonRed = exits.some(([, kw, code]) => kw !== 'exit' || code === '' || code === '0' || !/^[1-9]\d*$/.test(code));
  return nonRed ? 'green' : 'red';
}

/** Конец if-блока: позиция `else`/`elif`/`fi` того же уровня после `then`. */
function scanIf(struct: string, from: number): { thenStart: number; branchEnd: number; elseStart: number | null; fiEnd: number } | null {
  const kw = /(?<![\w$-])(if|then|elif|else|fi)(?![\w-])/g;
  kw.lastIndex = from;
  let depth = 0;
  let thenStart = -1;
  let branchEnd = -1;
  let elseStart: number | null = null;
  for (let m = kw.exec(struct); m; m = kw.exec(struct)) {
    const w = m[1];
    if (thenStart < 0) {
      if (w === 'then') thenStart = m.index + w.length;
      continue;
    }
    if (w === 'if') depth++;
    else if (w === 'fi') {
      if (depth === 0) {
        if (branchEnd < 0) branchEnd = m.index;
        return { thenStart, branchEnd, elseStart, fiEnd: m.index + 2 };
      }
      depth--;
    } else if ((w === 'else' || w === 'elif') && depth === 0 && branchEnd < 0) {
      branchEnd = m.index;
      elseStart = m.index + w.length;
    }
  }
  return null;
}

/** Все проверки пустоты секрета в тексте run. */
function checksInRun(run: string, names: Set<string>): Array<{ verdict: Verdict; branch: string; at: number }> {
  const struct = structural(run);
  const ref = refPattern(names);
  // Сама проверка: [ -z REF ], [[ ! -n REF ]], test -z REF. Кавычки вокруг
  // ссылки в struct стёрты, поэтому ищем по исходнику, а позиции сверяем.
  const testRe = new RegExp(`(\\[\\[?|(?<![\\w-])test)\\s+(!\\s+)?-([zn])\\s+"?${ref}"?\\s*(\\]\\]?)?`, 'g');
  const out: Array<{ verdict: Verdict; branch: string; at: number }> = [];
  for (const m of run.matchAll(testRe)) {
    const at = m.index ?? 0;
    // Внутри комментария — не проверка.
    if (struct[at] === ' ' && run[at] !== ' ') continue;
    const end = at + m[0].length;
    const trueWhenEmpty = (m[3] === 'z') !== Boolean(m[2]);
    // Что стоит перед проверкой в той же команде.
    const lineFrom = Math.max(struct.lastIndexOf('\n', at - 1), struct.lastIndexOf(';', at - 1)) + 1;
    const pre = struct.slice(lineFrom, at).trim();
    if (/^(if|elif)\b/.test(pre) || /\b(if|elif)\s+.*(\|\||&&)\s*$/.test(pre)) {
      const ifAt = lineFrom + struct.slice(lineFrom, at).search(/\b(if|elif)\b/);
      const blk = scanIf(struct, ifAt);
      if (!blk) { out.push({ verdict: 'fallthrough', branch: run.slice(at), at }); continue; }
      if (trueWhenEmpty) {
        out.push({ verdict: judgeBranch(struct.slice(blk.thenStart, blk.branchEnd)), branch: run.slice(blk.thenStart, blk.branchEnd), at });
      } else if (blk.elseStart !== null) {
        out.push({ verdict: judgeBranch(struct.slice(blk.elseStart, blk.fiEnd - 2)), branch: run.slice(blk.elseStart, blk.fiEnd - 2), at });
      } else {
        // `if [ -n "$S" ]; then <работа>; fi` без else: при пустом секрете
        // работа молча пропускается, шаг зелёный.
        out.push({ verdict: 'fallthrough', branch: '', at });
      }
      continue;
    }
    // Команда: [ -z S ] && X  |  [ -n S ] || X
    const rest = struct.slice(end);
    const op = rest.match(/^\s*(&&|\|\|)\s*/);
    if (!op) { out.push({ verdict: 'fallthrough', branch: '', at }); continue; }
    const runsWhenEmpty = (op[1] === '&&') === trueWhenEmpty;
    if (!runsWhenEmpty) {
      // [ -n S ] && AUTH=(…) — только присваивание: работа идёт и без секрета.
      // [ -n S ] && curl … — при пустом секрете вызов пропущен, шаг идёт дальше.
      const guarded = struct.slice(end + op[0].length);
      out.push({ verdict: /^[A-Za-z_]\w*=/.test(guarded) ? 'optional' : 'fallthrough', branch: '', at });
      continue;
    }
    const cmdFrom = end + op[0].length;
    let cmdTo: number;
    if (struct[cmdFrom] === '{') {
      cmdTo = struct.indexOf('}', cmdFrom) + 1;
    } else {
      const stop = struct.slice(cmdFrom).search(/[;\n]|&&|\|\|/);
      cmdTo = stop < 0 ? struct.length : cmdFrom + stop;
    }
    out.push({ verdict: judgeBranch(struct.slice(cmdFrom, cmdTo)), branch: run.slice(cmdFrom, cmdTo), at });
  }
  return out;
}

/**
 * Начала строк, где секрет стоит внутри [ … ] / test вне кавычек и
 * комментариев, — перепись для сверки полноты разбора.
 */
function testLines(run: string, names: Set<string>): number[] {
  const struct = structural(run);
  const inBracket = new RegExp(`(\\[\\[?|(?<![\\w-])test\\s)[^\\]\\n]*${refPattern(names)}`);
  const lines: number[] = [];
  let pos = 0;
  for (const line of run.split('\n')) {
    const s = struct.slice(pos, pos + line.length);
    // Скобка проверки — в коде (не в строке и не в комментарии), секрет — в ней.
    if (/(\[\[?|(?<![\w-])test\s)/.test(s) && inBracket.test(line)) lines.push(pos);
    pos += line.length + 1;
  }
  return lines;
}

interface WfStep { name?: unknown; id?: unknown; if?: unknown; env?: unknown; run?: unknown }
interface WfJob { if?: unknown; env?: unknown; steps?: unknown }

function analyzeWorkflow(file: string, text: string): { checks: Check[]; unparsed: string[] } {
  const doc = load(text);
  const checks: Check[] = [];
  const unparsed: string[] = [];
  if (!isObj(doc) || !isObj(doc.jobs)) return { checks, unparsed };
  for (const [jobId, jobRaw] of Object.entries(doc.jobs)) {
    if (!isObj(jobRaw)) continue;
    const job = jobRaw as WfJob;
    const jobNames = secretNames(doc.env, job.env);
    const condMentions = (cond: unknown, names: Set<string>) =>
      typeof cond === 'string' &&
      (/\bsecrets\.CRON_SECRET\b/.test(cond) || [...names].some((n) => new RegExp(`\\benv\\.${esc(n)}\\b`).test(cond)));
    if (condMentions(job.if, jobNames)) {
      checks.push({ file, job: jobId, step: '(job if:)', verdict: 'step-skip', loud: false, branch: String(job.if) });
    }
    const steps = Array.isArray(job.steps) ? (job.steps as unknown[]) : [];
    steps.forEach((stepRaw, i) => {
      if (!isObj(stepRaw)) return;
      const step = stepRaw as WfStep;
      const label = String(step.id ?? step.name ?? `#${i}`);
      const names = secretNames(doc.env, job.env, step.env);
      if (condMentions(step.if, names)) {
        checks.push({ file, job: jobId, step: label, verdict: 'step-skip', loud: false, branch: String(step.if) });
      }
      if (typeof step.run !== 'string') return;
      const run = step.run;
      const found = checksInRun(run, names);
      for (const c of found) {
        checks.push({ file, job: jobId, step: label, verdict: c.verdict, loud: /::(error|warning)::/.test(c.branch), branch: c.branch.trim() });
      }
      // Полнота: каждая строка-проверка секрета узнана разбором.
      const struct = structural(run);
      for (const lineAt of testLines(run, names)) {
        const nl = run.indexOf('\n', lineAt);
        const lineEnd = nl < 0 ? run.length : nl;
        const covered = found.some((c) => c.at >= lineAt && c.at < lineEnd);
        if (!covered && struct.slice(lineAt, lineEnd).trim() !== '') {
          unparsed.push(`${file} · ${jobId} · ${label}: ${run.slice(lineAt, lineEnd).trim()}`);
        }
      }
    });
  }
  return { checks, unparsed };
}

// ── Исключения (самоустаревающие) ─────────────────────────────────────────
//
// Файл здесь — только с причиной словами. Исключение, в котором нарушения
// больше нет, краснеет: запись обязана уйти вместе с последним `exit 0`.
// Ветка исключения обязана быть громкой (::warning::), а не немой.

const EXCEPTIONS: Record<string, string> = {
  'volcano-merge-gate.yml':
    'Срабатывает и на pull_request: на PR из форка GitHub секретов не отдаёт, и ' +
    'красный исход здесь сделал бы будильник merge-gate обязательной проверкой ' +
    'мержа. Это решение владельца (дорожная карта аудита 15.10, п. 1.3), не ' +
    'побочный эффект правки. Пропуск громкий: ::warning:: в аннотациях прогона.',
  'post-merge.yml':
    'Запускается закрытием PR (pull_request: closed) — тот же довод про форки. ' +
    'Шаг переписи каталога для README мягкий по замыслу (04.09, шапка шага: ' +
    '«отказ переписи не роняет job и не подменяет числа»): HTTP-отказ там тоже ' +
    'не красит прогон, а красный выход остановил бы обновление остальных ' +
    'счётчиков и коммит. Сделать его красным — решение владельца.',
  'dsh-vedar-probe.yml':
    'Шаг 5 ручной пробы (журнал Ведара видит клиента dsh) — справочный: вердикт ' +
    'пробы выносят шаги 1–4, а все отказы шага 5, включая «перепись не ' +
    'прочиталась», по замыслу пробы — ::warning::. Красить прогон только за ' +
    'нехватку секрета при мягких прочих отказах было бы непоследовательно.',
};

// ── Прогон по репозиторию ─────────────────────────────────────────────────

const files = readdirSync(join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f)).sort();
const analyzed = files.map((f) => ({ f, ...analyzeWorkflow(f, readFileSync(join(ROOT, WF_DIR, f), 'utf-8')) }));
const allChecks = analyzed.flatMap((a) => a.checks);
const allUnparsed = analyzed.flatMap((a) => a.unparsed);
const fmt = (c: Check) => `${c.file} · ${c.job} · ${c.step} → ${c.verdict}: ${c.branch.replace(/\s+/g, ' ').slice(0, 120)}`;

describe('нет CRON_SECRET — прогон красный (P2-09, §4.0)', () => {
  it('разбор нашёл проверки секрета (ноль при непустом входе — отказ сторожа)', () => {
    // 0 найденных при десятках workflow с секретом значило бы, что разбор
    // сломан, а не что нарушений нет.
    const withSecret = files.filter((f) => /secrets\.CRON_SECRET/.test(readFileSync(join(ROOT, WF_DIR, f), 'utf-8')));
    expect(withSecret.length).toBeGreaterThan(20);
    expect(new Set(allChecks.map((c) => c.file)).size).toBeGreaterThan(20);
  });

  it('каждая строка-проверка секрета узнана разбором (новая форма не проскальзывает)', () => {
    expect(allUnparsed, 'проверка секрета в форме, которую сторож не понимает — научи разбор, а не обходи').toEqual([]);
  });

  it('вне исключений ветка «секрет пуст» кончается exit <не ноль>', () => {
    const bad = allChecks.filter((c) => !EXCEPTIONS[c.file] && c.verdict !== 'red' && c.verdict !== 'optional').map(fmt);
    expect(bad, 'пустой CRON_SECRET даёт зелёный прогон — нужен echo "::error::…" и exit 1').toEqual([]);
  });

  it('исключение — с причиной словами и всё ещё нужно (самоустаревает)', () => {
    for (const [file, reason] of Object.entries(EXCEPTIONS)) {
      expect(files, `${file} из исключений больше нет в ${WF_DIR} — убери запись`).toContain(file);
      expect(reason.length, `${file}: причина обязана быть словами, не пометкой`).toBeGreaterThan(80);
      const nonRed = allChecks.filter((c) => c.file === file && c.verdict !== 'red' && c.verdict !== 'optional');
      expect(nonRed.length, `${file} больше не зеленеет без секрета — убери его из EXCEPTIONS`).toBeGreaterThan(0);
    }
  });

  it('пропуск в исключении громкий, а не немой', () => {
    const mute = allChecks
      .filter((c) => EXCEPTIONS[c.file] && c.verdict !== 'red' && c.verdict !== 'optional' && !c.loud)
      .map(fmt);
    expect(mute, 'исключение не освобождает от аннотации: ::warning:: с именем секрета').toEqual([]);
  });
});

// ── Разбор на граничных формах (сторож проверяет себя) ────────────────────

const wf = (run: string, env = 'CRON_SECRET: ${{ secrets.CRON_SECRET }}', extra = '') =>
  `on: workflow_dispatch\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: s\n${extra}        env:\n          ${env}\n        run: |\n${run
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n')}\n`;
const verdicts = (text: string) => analyzeWorkflow('t.yml', text).checks.map((c) => c.verdict);
const unparsedOf = (text: string) => analyzeWorkflow('t.yml', text).unparsed;

describe('разбор: какие формы что значат', () => {
  it('однострочный exit 0 — зелёный, exit 1 — красный', () => {
    expect(verdicts(wf('if [ -z "$CRON_SECRET" ]; then echo "CRON_SECRET not set"; exit 0; fi\ncurl x'))).toEqual(['green']);
    expect(verdicts(wf('if [ -z "$CRON_SECRET" ]; then echo "::error::CRON_SECRET не задан"; exit 1; fi'))).toEqual(['red']);
  });

  it('многострочный блок, ${VAR:-}, голый exit', () => {
    expect(verdicts(wf('if [ -z "${CRON_SECRET:-}" ]; then\n  echo "skipping"\n  exit 0\nfi'))).toEqual(['green']);
    expect(verdicts(wf('if [ -z "$CRON_SECRET" ]; then exit; fi'))).toEqual(['green']);
    expect(verdicts(wf('if [ -z "${CRON_SECRET:-}" ]; then\n  echo "::error::нет"\n  exit 1\nfi'))).toEqual(['red']);
  });

  it('ветка без выхода — шаг идёт дальше без секрета', () => {
    expect(verdicts(wf('if [ -z "$CRON_SECRET" ]; then\n  echo "нет секрета"\nfi\ncurl x'))).toEqual(['fallthrough']);
  });

  it('вложенный if внутри ветки не путает конец блока', () => {
    const run = 'if [ -z "$CRON_SECRET" ]; then\n  if [ -n "$X" ]; then echo a; fi\n  exit 0\nfi';
    expect(verdicts(wf(run))).toEqual(['green']);
  });

  it('команды через && и ||', () => {
    expect(verdicts(wf('[ -z "$CRON_SECRET" ] && exit 0\ncurl x'))).toEqual(['green']);
    expect(verdicts(wf('[ -n "$CRON_SECRET" ] || { echo "::error::нет"; exit 1; }'))).toEqual(['red']);
    expect(verdicts(wf('[ -n "$CRON_SECRET" ] && curl -H "Authorization: Bearer $CRON_SECRET" x'))).toEqual(['fallthrough']);
  });

  it('[ -n ] && присваивание — секрет необязателен, а не пропуск', () => {
    expect(verdicts(wf('[ -n "$CRON_SECRET" ] && AUTH=(-H "Authorization: Bearer $CRON_SECRET")\ncurl "${AUTH[@]}" x'))).toEqual(['optional']);
  });

  it('if -n без else: работа молча пропущена', () => {
    expect(verdicts(wf('if [ -n "$CRON_SECRET" ]; then\n  curl x\nfi'))).toEqual(['fallthrough']);
    expect(verdicts(wf('if [ -n "$CRON_SECRET" ]; then\n  curl x\nelse\n  exit 1\nfi'))).toEqual(['red']);
  });

  it('секрет под другим именем и прямо выражением', () => {
    expect(verdicts(wf('if [ -z "$SECRET" ]; then exit 0; fi', 'SECRET: ${{ secrets.CRON_SECRET }}'))).toEqual(['green']);
    expect(verdicts(wf('if [ -z "${{ secrets.CRON_SECRET }}" ]; then exit 0; fi', 'X: y'))).toEqual(['green']);
    // Чужой секрет — не наш предмет.
    expect(verdicts(wf('if [ -z "$TOKEN" ]; then exit 0; fi', 'TOKEN: ${{ secrets.OTHER }}'))).toEqual([]);
  });

  it('условие шага по секрету — тихий пропуск', () => {
    const text = wf('curl x', 'CRON_SECRET: ${{ secrets.CRON_SECRET }}', "        if: env.CRON_SECRET != ''\n");
    expect(verdicts(text)).toEqual(['step-skip']);
  });

  it('проверка в комментарии и в тексте сообщения — не проверка', () => {
    expect(verdicts(wf('# if [ -z "$CRON_SECRET" ]; then exit 0; fi\necho "[ -z $CRON_SECRET ]"'))).toEqual([]);
  });

  it('непонятая форма проверки попадает в перепись, а не теряется', () => {
    expect(unparsedOf(wf('[[ "$CRON_SECRET" == "" ]] && exit 0'))).toHaveLength(1);
  });
});
