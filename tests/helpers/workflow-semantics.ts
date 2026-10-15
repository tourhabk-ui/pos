/**
 * Смысл workflow GitHub Actions и контекста сборки Docker — для сторожей,
 * которые судят ПОВЕДЕНИЕ выката, а не текст файла (CLAUDE.md §4, решение
 * владельца 13.10). Заведено аудитом 15.10 (находка AR-deploy).
 *
 * Три вещи, которые иначе пришлось бы сверять регуляркой по исходнику:
 *  - `if:` и `${{ }}` — вычисляются подмножеством языка выражений GitHub
 *    (сравнение, &&, ||, !, скобки, литералы, пути контекста, функция
 *    `contains`). Чего здесь нет (прочие функции, индексы), то бросает
 *    исключение: сторож обязан краснеть на непонятом выражении, а не молча
 *    считать его ложным;
 *  - фильтр путей у push / pull_request — по правилам GitHub (`*` не
 *    пересекает `/`, `**` пересекает, `!` в `paths` отменяет совпадение,
 *    решает последнее подходящее правило);
 *  - .dockerignore — по правилам Docker (шаблон исключает и сам путь, и всё
 *    под совпавшим каталогом; `!` возвращает; решает последнее подходящее;
 *    `*.md` без `**` ловит только корень).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

export interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

export interface WorkflowJob {
  if?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

export interface PathFilter {
  branches?: string[];
  paths?: string[];
  'paths-ignore'?: string[];
}

export interface Workflow {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
  jobs: Record<string, WorkflowJob>;
}

/** Workflow из репозитория. `on:` js-yaml читает как ключ `true` — это не опечатка. */
export function loadWorkflow(relPath: string, root: string = process.cwd()): Workflow {
  const doc = load(readFileSync(join(root, relPath), 'utf-8')) as Record<string, unknown>;
  const on = (doc['on'] ?? doc['true']) as Record<string, unknown>;
  return { ...(doc as unknown as Workflow), on };
}

export function stepByName(job: WorkflowJob, name: string): WorkflowStep {
  const step = (job.steps ?? []).find((s) => s.name === name);
  if (!step) throw new Error(`шаг «${name}» не найден`);
  return step;
}

// ── Выражения GitHub ───────────────────────────────────────────────────────

type Value = string | number | boolean | null | Record<string, unknown> | unknown[];

type Token =
  | { t: 'op'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'path'; v: string }
  | { t: 'fn'; v: string };

/**
 * Функции, которые сторож умеет вычислять. `contains` нужен условию свипера
 * CI (`!contains(head_commit.message, '[ci-sweep]')`); прочие бросают — так же,
 * как раньше бросали все.
 */
const FUNCTIONS = new Set(['contains']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()!<>,'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`незакрытая строка в выражении: ${src}`);
        if (src[i] === "'" && src[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const path = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(src.slice(i));
    if (path) {
      if (src[i + path[0].length] === '(' && FUNCTIONS.has(path[0].toLowerCase())) {
        out.push({ t: 'fn', v: path[0].toLowerCase() });
        i += path[0].length;
        continue;
      }
      if (src[i + path[0].length] === '(' || src[i + path[0].length] === '[') {
        throw new Error(`функции и индексы в выражении не поддержаны сторожем: ${src}`);
      }
      out.push({ t: 'path', v: path[0] });
      i += path[0].length;
      continue;
    }
    throw new Error(`непонятный символ «${c}» в выражении: ${src}`);
  }
  return out;
}

function truthy(v: Value): boolean {
  return !(v === false || v === null || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));
}

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return NaN;
}

/** Равенство GitHub: строки — без учёта регистра, разные типы — через число. */
function looseEq(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b && (a === null || typeof a !== 'object')) return a === b;
  if (a === null && b === null) return true;
  const x = toNumber(a);
  const y = toNumber(b);
  return !Number.isNaN(x) && x === y;
}

function lookup(ctx: Record<string, unknown>, path: string): Value {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? null : (cur as Value);
}

/** Строковое представление значения так, как его сравнивают функции GitHub. */
function asString(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * contains(search, item): у массива — есть ли элемент, равный item; у строки —
 * подстрока без учёта регистра (документация GitHub, «Expressions → contains»).
 */
function callFunction(name: string, args: Value[], src: string): Value {
  if (name === 'contains') {
    if (args.length !== 2) throw new Error(`contains ждёт два аргумента: ${src}`);
    const [search, item] = args;
    if (Array.isArray(search)) return search.some((x) => looseEq(x as Value, item));
    return asString(search).toLowerCase().includes(asString(item).toLowerCase());
  }
  throw new Error(`функция ${name} не поддержана сторожем: ${src}`);
}

/** Вычисляет выражение без обёртки `${{ }}` (или с ней — тогда снимает). */
export function evalExpr(expr: string, ctx: Record<string, unknown>): Value {
  const src = expr.trim().replace(/^\$\{\{((?:(?!\}\})[\s\S])*)\}\}$/, '$1');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v;

  function primary(): Value {
    const tk = toks[p++];
    if (!tk) throw new Error(`выражение оборвано: ${src}`);
    if (tk.t === 'op' && tk.v === '(') {
      const v = or();
      if (!isOp(')')) throw new Error(`нет закрывающей скобки: ${src}`);
      p++;
      return v;
    }
    if (tk.t === 'str') return tk.v;
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'path') return lookup(ctx, tk.v);
    if (tk.t === 'fn') {
      if (!isOp('(')) throw new Error(`после ${tk.v} нет скобки: ${src}`);
      p++;
      const args: Value[] = [];
      if (!isOp(')')) {
        args.push(or());
        while (isOp(',')) { p++; args.push(or()); }
      }
      if (!isOp(')')) throw new Error(`нет закрывающей скобки у ${tk.v}: ${src}`);
      p++;
      return callFunction(tk.v, args, src);
    }
    throw new Error(`неожиданный оператор «${tk.v}»: ${src}`);
  }
  function unary(): Value {
    if (isOp('!')) { p++; return !truthy(unary()); }
    return primary();
  }
  function cmp(): Value {
    let left = unary();
    while (isOp('==') || isOp('!=') || isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
      const op = (toks[p++] as { v: string }).v;
      const right = unary();
      if (op === '==') left = looseEq(left, right);
      else if (op === '!=') left = !looseEq(left, right);
      else {
        const x = toNumber(left);
        const y = toNumber(right);
        left = op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
      }
    }
    return left;
  }
  function and(): Value {
    let left = cmp();
    while (isOp('&&')) { p++; const right = cmp(); left = truthy(left) ? right : left; }
    return left;
  }
  function or(): Value {
    let left = and();
    while (isOp('||')) { p++; const right = and(); left = truthy(left) ? left : right; }
    return left;
  }
  const v = or();
  if (p !== toks.length) throw new Error(`лишнее в конце выражения: ${src}`);
  return v;
}

/** `if:` джоба или шага: нет условия — значит «да». */
export function evalIf(cond: string | undefined, ctx: Record<string, unknown>): boolean {
  if (cond === undefined) return true;
  return truthy(evalExpr(cond, ctx));
}

/** Значение env/поля с подстановками `${{ }}`; целиком-выражение отдаёт сырой тип. */
export function evalTemplate(value: string | boolean, ctx: Record<string, unknown>): Value {
  if (typeof value === 'boolean') return value;
  // Целиком одно выражение — только если внутри нет второго `}}`.
  const whole = /^\s*\$\{\{((?:(?!\}\})[\s\S])*)\}\}\s*$/.exec(value);
  if (whole) return evalExpr(whole[1], ctx);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => String(evalExpr(e, ctx) ?? ''));
}

// ── Фильтр путей GitHub ────────────────────────────────────────────────────

// Шаблон пути в regex: двойная звезда со слешем — любые каталоги (и ни одного),
// одиночная звезда — внутри одного каталога.
function globToRegex(glob: string): RegExp {
  let rx = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        rx += '(?:.*/)?';
      } else {
        rx += '.*';
      }
    } else if (c === '*') {
      rx += '[^/]*';
    } else if (c === '?') {
      rx += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) throw new Error(`незакрытый класс в шаблоне ${glob}`);
      rx += glob.slice(i, end + 1);
      i = end;
    } else {
      rx += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${rx}$`);
}

/** Запустит ли изменение файла `file` событие с таким фильтром (push/pull_request). */
export function githubTriggersOn(filter: PathFilter | null | undefined, file: string): boolean {
  if (!filter) return true;
  if (filter.paths && filter['paths-ignore']) {
    throw new Error('paths и paths-ignore у одного события GitHub не допускает');
  }
  if (filter['paths-ignore']) {
    return !filter['paths-ignore'].some((p) => globToRegex(p).test(file));
  }
  if (filter.paths) {
    let hit = false;
    for (const raw of filter.paths) {
      const neg = raw.startsWith('!');
      const pat = neg ? raw.slice(1) : raw;
      if (globToRegex(pat).test(file)) hit = !neg;
    }
    return hit;
  }
  return true;
}

// ── .dockerignore ──────────────────────────────────────────────────────────

export function dockerignorePatterns(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function cleanDockerPattern(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/^\.\//, '');
}

/** Исключён ли файл из контекста сборки (`COPY . .` его не увидит). */
export function dockerIgnored(file: string, patterns: string[]): boolean {
  const parents: string[] = [];
  const parts = file.split('/');
  for (let i = 1; i <= parts.length; i++) parents.push(parts.slice(0, i).join('/'));
  let ignored = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const pat = cleanDockerPattern(neg ? raw.slice(1).trim() : raw);
    if (!pat) continue;
    const rx = globToRegex(pat);
    if (parents.some((p) => rx.test(p))) ignored = !neg;
  }
  return ignored;
}
