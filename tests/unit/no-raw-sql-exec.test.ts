/**
 * В lib/ нет экспортированной функции, которая отдаёт базе переданную строку SQL.
 *
 * Разбор находок #1428 (задача владельца 27.11): `applySchemaFix` выполнял
 * переданный SQL целиком, `runDiagnosticQuery` — обёрнутым подзапросом. Оба
 * стояли за реестром прав агентств, и оба были экспортированы — а прямой
 * импорт функции реестр прав не спрашивает. Чёрные списки слов («DROP TABLE»,
 * «;») такую функцию не спасают: их обходят регистром, другими словами DDL и
 * функциями с побочным действием.
 *
 * Правило: если экспортированная функция зовёт `.query(...)` с ОДНИМ
 * аргументом и в этом аргументе стоит её собственный параметр — это
 * исполнение строки снаружи. Значения уходят в базу только вторым аргументом
 * (`$1, $2`), текст запроса — из кода.
 *
 * Судит разбор TypeScript, а не регулярка по исходнику: так видны и
 * `export const f = async (sql) => …`, и `client.query(\`…${sql}\`)`, и
 * обёртки вида `pool.query(wrap(sql))`. Это запрет («такого быть не должно»),
 * поэтому сторож читает текст кода — по правилу CLAUDE.md «Сторож судит
 * поведение, не текст».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { repoCodeFiles } from '../helpers/repo-code';

const ROOT = process.cwd();

export interface RawSqlExec { file: string; fn: string; line: number }

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Может ли параметр нести строку SQL. Число и флаг — нет: `LIMIT ${n}` с
 * числом и выбор постоянного куска по `true/false` текст запроса снаружи не
 * несут. Строка, `any`, `unknown`, объединение со строкой и параметр без типа —
 * могут.
 */
function stringish(p: ts.ParameterDeclaration): boolean {
  const t = p.type;
  if (t) {
    const one = (n: ts.TypeNode): boolean =>
      n.kind === ts.SyntaxKind.StringKeyword || n.kind === ts.SyntaxKind.AnyKeyword
      || n.kind === ts.SyntaxKind.UnknownKeyword
      || (ts.isUnionTypeNode(n) && n.types.some(one))
      || ts.isTypeLiteralNode(n) || ts.isTypeReferenceNode(n);
    return one(t);
  }
  const init = p.initializer;
  if (!init) return true;
  return !(ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword
    || init.kind === ts.SyntaxKind.FalseKeyword);
}

function paramNames(fn: ts.SignatureDeclaration): Set<string> {
  const names = new Set<string>();
  const collect = (b: ts.BindingName) => {
    if (ts.isIdentifier(b)) names.add(b.text);
    else for (const el of b.elements) if (!ts.isOmittedExpression(el)) collect(el.name);
  };
  for (const p of fn.parameters) if (stringish(p)) collect(p.name);
  return names;
}

function mentions(node: ts.Node, names: Set<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      // `obj.sql` — свойство, а не параметр: смотрим только на сами имена.
      const parent = n.parent;
      if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === n)) { hit = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** Найти в исходнике экспортированные функции, исполняющие переданную строку. */
export function findRawSqlExec(file: string, code: string): RawSqlExec[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: RawSqlExec[] = [];

  const check = (name: string, fn: ts.SignatureDeclaration & { body?: ts.Node }) => {
    if (!fn.body) return;
    const params = paramNames(fn);
    if (params.size === 0) return;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'query' && n.arguments.length === 1
        && mentions(n.arguments[0], params)) {
        out.push({ file, fn: name, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && isExported(st) && st.name) check(st.name.text, st);
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (init && ts.isIdentifier(d.name) && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          check(d.name.text, init);
        }
      }
    }
  }
  return out;
}

describe('lib/: ни одна экспортированная функция не исполняет переданную строку SQL', () => {
  it('перепись по всему lib/', () => {
    // repoCodeFiles отдаёт пути от корня репозитория («lib/…»).
    const files = repoCodeFiles(ROOT).filter((f) => f.startsWith('lib/') && /\.(ts|tsx)$/.test(f));
    // Пустой обход зеленел бы всегда: сторож обязан видеть, что он читает.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/agents/tools/board-executor-tools.ts');
    const found = files.flatMap((f) => findRawSqlExec(f, readFileSync(join(ROOT, f), 'utf-8')));
    expect(found, found.map((x) => `${x.file}:${x.line} ${x.fn}`).join('\n')).toEqual([]);
  });

  describe('правило ловит то, что должно', () => {
    it('прямое исполнение параметра — applySchemaFix как был', () => {
      const code = `export async function applySchemaFix(d: string, sql: string) {
        const client = await pool.connect(); await client.query('BEGIN'); await client.query(sql); }`;
      expect(findRawSqlExec('x.ts', code).map((x) => x.fn)).toEqual(['applySchemaFix']);
    });

    it('обёртка вокруг параметра — runDiagnosticQuery как был', () => {
      const code = `export async function runDiagnosticQuery(sql: string, label = 'd') {
        return pool.query(withDiagnosticLimit(sql)); }`;
      expect(findRawSqlExec('x.ts', code).map((x) => x.fn)).toEqual(['runDiagnosticQuery']);
    });

    it('стрелка в export const и параметр в шаблоне строки', () => {
      const code = 'export const run = async (table: string) => db.query(`SELECT * FROM ${table}`);';
      expect(findRawSqlExec('x.ts', code).map((x) => x.fn)).toEqual(['run']);
    });

    it('строка или null, без типа, unknown — тоже строка', () => {
      const code = `export async function a(sql: string | null) { await pool.query(sql!); }
        export async function b(sql) { await pool.query(sql); }
        export async function c(sql: unknown) { await pool.query(String(sql)); }`;
      expect(findRawSqlExec('x.ts', code).map((x) => x.fn)).toEqual(['a', 'b', 'c']);
    });

    it('разобранный параметр-объект тоже параметр', () => {
      const code = 'export async function f({ sql }: { sql: string }) { await pool.query(sql); }';
      expect(findRawSqlExec('x.ts', code).map((x) => x.fn)).toEqual(['f']);
    });
  });

  describe('и не ловит законное', () => {
    it('параметры вторым аргументом', () => {
      const code = 'export async function f(id: string) { return pool.query(`SELECT 1 FROM t WHERE id = $1`, [id]); }';
      expect(findRawSqlExec('x.ts', code)).toEqual([]);
    });

    it('клиент параметром, текст запроса из кода', () => {
      const code = "export async function f(client: Db) { await client.query('BEGIN'); }";
      expect(findRawSqlExec('x.ts', code)).toEqual([]);
    });

    it('свойство с тем же именем, что параметр, — не параметр', () => {
      const code = "export async function f(sql: string) { await pool.query(QUERIES.sql); void sql; }";
      expect(findRawSqlExec('x.ts', code)).toEqual([]);
    });

    it('число и флаг не несут текст запроса', () => {
      const code = `export async function audit(sampleLimit = 20, all: boolean = false, n: number) {
        await pool.query(\`SELECT 1 LIMIT \${sampleLimit}\`);
        await pool.query(\`SELECT 1 \${all ? '' : 'WHERE x'}\`);
        await pool.query(\`SELECT 1 LIMIT \${n}\`); }`;
      expect(findRawSqlExec('x.ts', code)).toEqual([]);
    });

    it('неэкспортированная функция в счёт не идёт', () => {
      const code = 'async function inner(sql: string) { await pool.query(sql); }';
      expect(findRawSqlExec('x.ts', code)).toEqual([]);
    });
  });
});
