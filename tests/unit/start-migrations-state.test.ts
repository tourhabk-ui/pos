// @vitest-environment node
/**
 * Отказ наката миграций при старте — громкий, но не роняющий (аудит 15.10,
 * A08, ответ на вопрос 8).
 *
 * До 15.10 start.js ловил отказ наката и писал «(continuing)» в лог выката,
 * а раннер на упавшем файле и вовсе выходил с кодом 0: контейнер со схемой,
 * отстающей от кода, снаружи не отличался от чистого. Решение (в): сервер
 * стартует (SOS и полевой контур важнее новой фичи), но исход наката назван —
 * в /api/health прокси, в env Next для крона health и в сверке deploy.yml.
 *
 * Сторож судит поведение (CLAUDE.md §4, 13.10):
 *  1. правило start.js — функции блока <migrationsState> на граничных данных:
 *     три состояния, причина, только имя файла и SQLSTATE (без текста ошибки),
 *     таймаут из MIGRATE_TIMEOUT_MS с проверкой числа;
 *  2. настоящий scripts/migrate-standalone.js с подложенным драйвером pg:
 *     отчёт «начинаю файл», итог с упавшими файлами и SQLSTATE, отказ базы;
 *  3. настоящий start.js с подложенным раннером и server.js: раннер упал
 *     (exit 1), оборван таймаутом, промолчал — Next всё равно запущен,
 *     /api/health и env Next называют одно и то же состояние.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START = join(process.cwd(), 'start.js');
const RUNNER = join(process.cwd(), 'scripts', 'migrate-standalone.js');
const BLOCK = readFileSync(START, 'utf8').match(/\/\/ <migrationsState>([\s\S]*?)\/\/ <\/migrationsState>/)?.[1] ?? '';

interface Outcome {
  state: 'ok' | 'failed' | 'unknown';
  reason: string;
  file: string | null;
  sqlstate: string | null;
  failed_count: number | null;
  at: string | null;
}
interface Exec { timedOut: boolean; status: number | null; signal: string | null }

const { migrateTimeoutMs, migrationsOutcome } = new Function(
  `${BLOCK}; return { migrateTimeoutMs, migrationsOutcome };`,
)() as {
  migrateTimeoutMs: (raw: unknown) => { ms: number; warning: string | null };
  migrationsOutcome: (exec: Exec | null, report: unknown, at: string) => Outcome;
};

const AT = '2026-10-15T03:00:00.000Z';
const PHONE = '+7 914 123-45-67';
const MAIL = 'turist@example.com';

// ── 1. Правило ───────────────────────────────────────────────────────────

describe('правило start.js: исход наката', () => {
  it('блок правила на месте', () => {
    expect(BLOCK).toContain('function migrationsOutcome');
  });

  it('итог без ошибок — ok', () => {
    expect(migrationsOutcome(null, { phase: 'done', applied: 3, errors: 0, failed: [] }, AT))
      .toEqual({ state: 'ok', reason: 'applied', file: null, sqlstate: null, failed_count: 0, at: AT });
  });

  it('упавший файл при коде 0 — failed с файлом и SQLSTATE (раньше это сходило за чистый старт)', () => {
    const o = migrationsOutcome(null, {
      phase: 'done', applied: 1, errors: 2,
      failed: [{ file: '1300_tour_access.sql', sqlstate: '42703' }, { file: '1301_x.sql', sqlstate: null }],
    }, AT);
    expect(o).toEqual({ state: 'failed', reason: 'file_failed', file: '1300_tour_access.sql', sqlstate: '42703', failed_count: 2, at: AT });
  });

  it('отказ базы до файлов — unknown fatal с SQLSTATE: отстаёт ли схема, не известно', () => {
    expect(migrationsOutcome(null, { phase: 'fatal', sqlstate: '28P01' }, AT))
      .toMatchObject({ state: 'unknown', reason: 'fatal', sqlstate: '28P01', file: null });
  });

  it('последнее слово «начинаю файл» при коде 0 — оборвался на нём', () => {
    expect(migrationsOutcome(null, { phase: 'running', file: '1300_a.sql' }, AT))
      .toMatchObject({ state: 'failed', reason: 'interrupted', file: '1300_a.sql' });
  });

  it('раннер промолчал — unknown, а не ok (§4.0)', () => {
    expect(migrationsOutcome(null, null, AT)).toMatchObject({ state: 'unknown', reason: 'no_report' });
    expect(migrationsOutcome(null, { phase: 'что-то' }, AT)).toMatchObject({ state: 'unknown', reason: 'no_report' });
    expect(migrationsOutcome(null, { phase: 'done', failed: [] }, AT)).toMatchObject({ state: 'unknown', reason: 'report_malformed' });
    expect(migrationsOutcome(null, [1, 2], AT)).toMatchObject({ state: 'unknown' });
  });

  it('базы нет — накатывать некуда: unknown с причиной', () => {
    expect(migrationsOutcome(null, { phase: 'skipped', reason: 'no_database_url' }, AT))
      .toMatchObject({ state: 'unknown', reason: 'no_database_url' });
  });

  it('таймаут — failed timeout и файл, на котором стоял', () => {
    expect(migrationsOutcome({ timedOut: true, status: null, signal: 'SIGTERM' }, { phase: 'running', file: '1300_slow.sql' }, AT))
      .toMatchObject({ state: 'failed', reason: 'timeout', file: '1300_slow.sql' });
  });

  it('раннер упал без отчёта — failed, файл неизвестен (null), а не выдуман', () => {
    expect(migrationsOutcome({ timedOut: false, status: 1, signal: null }, null, AT))
      .toEqual({ state: 'failed', reason: 'exit_1', file: null, sqlstate: null, failed_count: null, at: AT });
    expect(migrationsOutcome({ timedOut: false, status: null, signal: 'SIGKILL' }, null, AT))
      .toMatchObject({ state: 'failed', reason: 'signal_SIGKILL' });
    expect(migrationsOutcome({ timedOut: false, status: null, signal: null }, null, AT))
      .toMatchObject({ state: 'failed', reason: 'spawn_failed' });
  });

  it('из отчёта берутся только имя файла и SQLSTATE — текст ошибки и ПД не проходят', () => {
    const o = migrationsOutcome(null, {
      phase: 'done', errors: 1,
      error: `value ${PHONE} violates`,
      failed: [{ file: `${PHONE}.sql`, sqlstate: MAIL, error: `duplicate ${MAIL}` }],
    }, AT);
    expect(o).toMatchObject({ state: 'failed', reason: 'file_failed', file: null, sqlstate: null });
    const text = JSON.stringify(o);
    expect(text).not.toContain('914');
    expect(text).not.toContain(MAIL);
    // Код узла — не SQLSTATE.
    expect(migrationsOutcome(null, { phase: 'fatal', sqlstate: 'EPIPE' }, AT).sqlstate).toBeNull();
  });
});

describe('правило start.js: MIGRATE_TIMEOUT_MS', () => {
  it('не задан — прежние 60000 без предупреждения', () => {
    for (const raw of [undefined, '', '   ']) expect(migrateTimeoutMs(raw)).toEqual({ ms: 60000, warning: null });
  });

  it('целое число в пределах — берётся', () => {
    expect(migrateTimeoutMs('90000')).toEqual({ ms: 90000, warning: null });
    expect(migrateTimeoutMs('1000').ms).toBe(1000);
    expect(migrateTimeoutMs('150000').ms).toBe(150000);
  });

  it('мусор и выход за пределы — умолчание и строка о том, что взято', () => {
    // Больше 150 с нельзя: на время наката прокси не отвечает и на /api/health,
    // а Timeweb ждёт здоровья не дольше трёх минут.
    for (const raw of ['abc', '0', '999', '150001', '1e5', '60000.5', '-5', '60 000']) {
      const t = migrateTimeoutMs(raw);
      expect(t.ms, raw).toBe(60000);
      expect(t.warning, raw).toMatch(/MIGRATE_TIMEOUT_MS/);
    }
  });
});

// ── 2. Настоящий раннер с подложенным драйвером ─────────────────────────

/**
 * Драйвер pg, которым раннер ходит в базу. Ведёт себя по FAKE_PG_MODE:
 *  ok      — всё проходит; выражение с FAIL_ME падает 42703 с ПД в тексте;
 *            выражение с HANG_ME не отвечает никогда;
 *  refuse  — база не пускает (28P01);
 *  econn   — сеть не дошла (ECONNREFUSED — код узла, не SQLSTATE).
 */
const FAKE_PG = `
const mode = process.env.FAKE_PG_MODE || 'ok';
function refuse() {
  if (mode === 'refuse') throw Object.assign(new Error('password authentication failed for user "vedar"'), { code: '28P01' });
  if (mode === 'econn') throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
}
async function run(sql) {
  refuse();
  const text = String(sql);
  if (text.includes('FAIL_ME')) throw Object.assign(new Error('column "fail_me" does not exist, value ${PHONE} ${MAIL}'), { code: '42703' });
  if (text.includes('HANG_ME')) return new Promise(() => {});
  return { rows: [] };
}
class Pool {
  async query(sql) { return run(sql); }
  async connect() { refuse(); return { query: (sql) => run(sql), release() {} }; }
  async end() {}
}
module.exports = { Pool };
`;

describe('настоящий scripts/migrate-standalone.js пишет отчёт для start.js', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrate-report-'));
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(RUNNER, join(dir, 'scripts', 'migrate-standalone.js'));
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(join(dir, 'migrations', '0001_a.sql'), 'SELECT 1;\n');
    writeFileSync(join(dir, 'migrations', '0002_b.sql'), 'SELECT FAIL_ME;\n');
    writeFileSync(join(dir, 'migrations', '0003_c.sql'), 'SELECT 3;\n');
    mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pg', 'index.js'), FAKE_PG);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function runRunner(env: Record<string, string | undefined>, stateName: string) {
    const stateFile = join(dir, stateName);
    const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, MIGRATE_STATE_FILE: stateFile };
    const r = spawnSync(process.execPath, ['scripts/migrate-standalone.js'], {
      cwd: dir, env: { ...base, ...env }, encoding: 'utf8', timeout: 20_000,
    });
    const report = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown> : null;
    return { code: r.status, out: `${r.stdout}${r.stderr}`, report, raw: existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '' };
  }

  it('упавший файл: итог называет его с SQLSTATE, без текста ошибки; код выхода прежний (0)', () => {
    const r = runRunner({ DATABASE_URL: 'postgres://fake/db' }, 'done.json');
    expect(r.code).toBe(0);
    expect(r.report).toEqual({ phase: 'done', applied: 2, skipped: 0, errors: 1, failed: [{ file: '0002_b.sql', sqlstate: '42703' }] });
    expect(r.raw).not.toContain('914');
    expect(r.raw).not.toContain(MAIL);
    expect(r.raw).not.toContain('does not exist');
  });

  it('база не пустила — fatal с SQLSTATE', () => {
    const r = runRunner({ DATABASE_URL: 'postgres://fake/db', FAKE_PG_MODE: 'refuse' }, 'fatal.json');
    expect(r.code).toBe(0);
    expect(r.report).toEqual({ phase: 'fatal', sqlstate: '28P01' });
  });

  it('сеть не дошла — fatal без SQLSTATE: код узла за него не выдаётся', () => {
    const r = runRunner({ DATABASE_URL: 'postgres://fake/db', FAKE_PG_MODE: 'econn' }, 'econn.json');
    expect(r.report).toEqual({ phase: 'fatal', sqlstate: null });
  });

  it('DATABASE_URL нет — skipped с причиной', () => {
    const r = runRunner({ DATABASE_URL: undefined }, 'skipped.json');
    expect(r.report).toEqual({ phase: 'skipped', reason: 'no_database_url' });
  });

  it('перед каждым неприменённым файлом — «начинаю»: зависший накат называет свой файл', async () => {
    writeFileSync(join(dir, 'migrations', '0002_b.sql'), 'SELECT HANG_ME;\n');
    const stateFile = join(dir, 'hang.json');
    const p = spawn(process.execPath, ['scripts/migrate-standalone.js'], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: 'postgres://fake/db', MIGRATE_STATE_FILE: stateFile },
      stdio: 'ignore',
    });
    try {
      const until = Date.now() + 10_000;
      let report: unknown = null;
      while (Date.now() < until) {
        if (existsSync(stateFile)) {
          report = JSON.parse(readFileSync(stateFile, 'utf8'));
          if ((report as { file?: string }).file === '0002_b.sql') break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(report).toEqual({ phase: 'running', file: '0002_b.sql' });
    } finally {
      p.kill('SIGKILL');
      writeFileSync(join(dir, 'migrations', '0002_b.sql'), 'SELECT FAIL_ME;\n');
    }
  }, 15_000);
});

// ── 3. Настоящий start.js ────────────────────────────────────────────────
//
// Подложенный server.js порт 3001 НЕ занимает: он только записывает, что
// получил от start.js, и ждёт SIGTERM. Так этот файл не делит порт с
// next-supervisor.test.ts, который идёт параллельно.

const FAKE_SERVER = `
const fs = require('fs');
fs.writeFileSync('next-env.json', JSON.stringify({ migrations: process.env.MIGRATIONS_STARTUP_STATE ?? null }));
fs.appendFileSync('starts.log', process.pid + '\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const RUNNERS: Record<string, string> = {
  // Упал без отчёта.
  exit1: 'process.exit(1);\n',
  // Отчёт об упавшем файле при коде 0 — так устроен настоящий раннер.
  fileFailed: `require('fs').writeFileSync(process.env.MIGRATE_STATE_FILE, JSON.stringify({ phase: 'done', applied: 4, errors: 1, failed: [{ file: '1300_tour_access.sql', sqlstate: '42703', error: 'value ${PHONE}' }] }));\n`,
  // Встал на файле и не кончил.
  hang: `require('fs').writeFileSync(process.env.MIGRATE_STATE_FILE, JSON.stringify({ phase: 'running', file: '1301_slow_index.sql' }));\nsetTimeout(() => {}, 30000);\n`,
  // Кончил кодом 0, ничего о себе не сказав.
  silent: 'process.exit(0);\n',
  ok: `require('fs').writeFileSync(process.env.MIGRATE_STATE_FILE, JSON.stringify({ phase: 'done', applied: 2, skipped: 1200, errors: 0, failed: [] }));\n`,
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function getHealth(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

interface StartRun { health: { status: number; body: Record<string, unknown> }; nextEnv: { migrations: string | null }; output: string; leftovers: string[] }

const procs: ChildProcess[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  for (const d of dirs) {
    if (existsSync(join(d, 'starts.log'))) {
      for (const pid of readFileSync(join(d, 'starts.log'), 'utf8').trim().split('\n').map(Number)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; // ESRCH — уже вышел
        }
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
});

async function runStart(runner: string, extraEnv: Record<string, string> = {}): Promise<StartRun> {
  const dir = mkdtempSync(join(tmpdir(), 'start-migrations-'));
  dirs.push(dir);
  copyFileSync(START, join(dir, 'start.js'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'migrate-standalone.js'), runner);
  writeFileSync(join(dir, 'server.js'), FAKE_SERVER);
  mkdirSync(join(dir, 'tmp'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), TMPDIR: join(dir, 'tmp'), ...extraEnv };
  // Без секрета задачи SAFETY_JOBS не ставятся; таймаут — по умолчанию, если не задан в случае.
  delete env.CRON_SECRET;
  if (!('MIGRATE_TIMEOUT_MS' in extraEnv)) delete env.MIGRATE_TIMEOUT_MS;
  const proc = spawn(process.execPath, ['start.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  let output = '';
  proc.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
  proc.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));

  const until = Date.now() + 15_000;
  while (!existsSync(join(dir, 'next-env.json'))) {
    if (Date.now() > until) throw new Error(`Next не запущен; вывод start.js:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const health = await getHealth(port);
  const nextEnv = JSON.parse(readFileSync(join(dir, 'next-env.json'), 'utf8')) as { migrations: string | null };
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 9000))]);
  return { health, nextEnv, output, leftovers: readdirSync(join(dir, 'tmp')) };
}

describe('настоящий start.js: отказ наката не роняет сервер и назван', () => {
  it('раннер упал (exit 1) — Next запущен, health 200 и migrations failed, Next знает то же', async () => {
    const r = await runStart(RUNNERS.exit1);
    expect(r.health.status, 'код ответа судит только Next — иначе Timeweb снял бы контейнер').toBe(200);
    expect(r.health.body.migrations).toMatchObject({ state: 'failed', reason: 'exit_1', file: null });
    expect(JSON.parse(r.nextEnv.migrations ?? 'null')).toEqual(r.health.body.migrations);
    expect(r.output).toMatch(/НАКАТ НЕ ЗАВЕРШЁН \(exit_1\): файл неизвестно/);
    expect(r.leftovers, 'файл отчёта раннера не убран').toEqual([]);
  }, 30_000);

  it('упавший файл при коде 0 — failed с файлом и SQLSTATE; текст ошибки наружу не уходит', async () => {
    const r = await runStart(RUNNERS.fileFailed);
    expect(r.health.body.migrations).toMatchObject({ state: 'failed', reason: 'file_failed', file: '1300_tour_access.sql', sqlstate: '42703', failed_count: 1 });
    expect(typeof (r.health.body.migrations as { at?: unknown }).at).toBe('string');
    expect(JSON.stringify(r.health.body)).not.toContain('914');
    expect(r.nextEnv.migrations ?? '').not.toContain('914');
    expect(r.output).not.toContain('914');
  }, 30_000);

  it('накат завис — оборван по MIGRATE_TIMEOUT_MS, назван файл, Next запущен', async () => {
    const t0 = Date.now();
    const r = await runStart(RUNNERS.hang, { MIGRATE_TIMEOUT_MS: '1000' });
    expect(Date.now() - t0, 'таймаут из env не применён — ждали дольше 30 с раннера').toBeLessThan(15_000);
    expect(r.health.body.migrations).toMatchObject({ state: 'failed', reason: 'timeout', file: '1301_slow_index.sql' });
    expect(r.health.status).toBe(200);
  }, 30_000);

  it('раннер промолчал — unknown, а не ok', async () => {
    const r = await runStart(RUNNERS.silent);
    expect(r.health.body.migrations).toMatchObject({ state: 'unknown', reason: 'no_report' });
    expect(JSON.parse(r.nextEnv.migrations ?? 'null')).toMatchObject({ state: 'unknown' });
  }, 30_000);

  it('чистый накат — ok', async () => {
    const r = await runStart(RUNNERS.ok, { MIGRATE_TIMEOUT_MS: 'не число' });
    expect(r.health.body.migrations).toMatchObject({ state: 'ok', reason: 'applied', failed_count: 0 });
    expect(r.output, 'мусор в MIGRATE_TIMEOUT_MS прошёл молча').toMatch(/MIGRATE_TIMEOUT_MS «не число».*беру 60000/);
  }, 30_000);
});
