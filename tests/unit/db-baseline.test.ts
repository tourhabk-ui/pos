/**
 * Baseline-схема прод-БД (задача #57 — бэкап-фактор, находка прогона 14.08).
 *
 * Master-таблицы (places, kamchatka_routes, leads, sos_events, ...) не
 * создавала ни одна миграция — схема существовала только на проде.
 * Теперь: снятый с прода baseline лежит в репозитории, восстанавливается
 * scripts/bootstrap-from-baseline.js (проверено на пустом Postgres 16:
 * 202/202 таблицы, 0 ошибок), setup-database.sh больше не ссылается на
 * удалённые файлы. Сторож держит это состояние.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';
import {
  parseBaselineHeader, serverMajorOf, BASELINE_LAST_MIGRATION_LABEL, BASELINE_SERVER_LABEL,
} from '@/lib/database/baseline-header';
import { lastMigration, migrationNumber, unnumberedMigrations } from '@/lib/database/migration-order';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'lib/database/baseline/schema-baseline.sql');
const BASELINE = readFileSync(BASELINE_PATH, 'utf-8');
const BOOTSTRAP = readFileSync(join(ROOT, 'scripts/bootstrap-from-baseline.js'), 'utf-8');
const SETUP = readFileSync(join(ROOT, 'scripts/setup-database.sh'), 'utf-8');

describe('baseline в репозитории', () => {
  it('master-таблицы, которых нет в миграциях, присутствуют', () => {
    for (const t of ['places', 'kamchatka_routes', 'leads', 'sos_events', 'operator_tours', 'operator_bookings']) {
      expect(BASELINE, t).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
    }
    // Обратная совместимость: agent_route_knowledge — VIEW (миграция 663/677).
    expect(BASELINE).toMatch(/CREATE OR REPLACE VIEW agent_route_knowledge /);
  });

  it('generated-колонки сняты правильно (падение первого съёма)', () => {
    expect(BASELINE).toMatch(/GENERATED ALWAYS AS \(/);
    expect(BASELINE).toMatch(/search_vector tsvector GENERATED ALWAYS AS/);
  });

  it('baseline лежит ВНЕ migrations/ — автоматика деплоя его не трогает', () => {
    expect(BASELINE_PATH).toContain('lib/database/baseline');
    expect(existsSync(join(ROOT, 'migrations/schema-baseline.sql'))).toBe(false);
  });
});

describe('метаданные свежести (ревизия 15.08, P2)', () => {
  const ASSEMBLER = readFileSync(join(ROOT, 'scripts/assemble-db-baseline.py'), 'utf-8');

  it('сборщик пишет snapshot_at, SHA воркфлоу и счётчики объектов', () => {
    expect(ASSEMBLER).toMatch(/snapshot_at:/);
    expect(ASSEMBLER).toMatch(/GITHUB_RUN_ID/);
    expect(ASSEMBLER).toMatch(/GITHUB_SHA/);
    expect(ASSEMBLER).toMatch(/Объектов на проде/);
    expect(ASSEMBLER).toMatch(/ДИСЦИПЛИНА АКТУАЛЬНОСТИ/);
  });
});

describe('bootstrap-from-baseline', () => {
  it('отказывается работать на непустой базе без --force', () => {
    expect(BOOTSTRAP).toMatch(/relkind = 'r'/);
    expect(BOOTSTRAP).toMatch(/--force/);
    expect(BOOTSTRAP).toMatch(/только на пустую базу/);
  });

  it('сплиттер общий с раннером миграций (урок 843), не свой split', () => {
    expect(BOOTSTRAP).toMatch(/require\('\.\/migrate-standalone\.js'\)/);
    expect(BOOTSTRAP).toMatch(/splitSqlStatements/);
    expect(BOOTSTRAP).not.toMatch(/\.split\(';'\)/);
  });

  it('после схемы помечает все миграции применёнными', () => {
    expect(BOOTSTRAP).toMatch(/INSERT INTO _migrations\(name\)/);
    expect(BOOTSTRAP).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('setup-database.sh ожил', () => {
  it('не ссылается на удалённые файлы (находка прогона 14.08)', () => {
    expect(SETUP).not.toMatch(/psql "\$DATABASE_URL" -f scripts\/init-postgresql\.sql/);
    expect(SETUP).not.toMatch(/psql "\$DATABASE_URL" -f scripts\/apply-new-schemas\.sql/);
  });

  it('идёт через bootstrap и общий раннер миграций', () => {
    expect(SETUP).toMatch(/node scripts\/bootstrap-from-baseline\.js/);
    expect(SETUP).toMatch(/node scripts\/migrate-standalone\.js/);
  });
});

/**
 * Шапка baseline — граница снимка и версия прода (аудит 15.10, P2-10, 1.8).
 *
 * Граница «что внутри снимка» жила литералом 863 в четырнадцати pg-тестах;
 * теперь её пишет сборщик снимка в шапку, а читает один разбор
 * (lib/database/baseline-header.ts). Сторож держит связку целиком:
 * производитель (сборщик) → файл → потребитель (разбор) → CI.
 */
describe('шапка baseline: разбор на граничных данных', () => {
  const head = (...lines: string[]) => [...lines, '', 'CREATE TABLE x (id int);'].join('\n');

  it('строка границы и сервера разбираются', () => {
    const h = parseBaselineHeader(head(
      '-- Baseline',
      `${BASELINE_SERVER_LABEL} PostgreSQL 18.1 (Ubuntu 18.1-1.pgdg24.04+2) on x86_64-pc-linux-gnu`,
      `${BASELINE_LAST_MIGRATION_LABEL} 862_mcp_handoffs.sql`,
    ));
    expect(h).toMatchObject({ lastMigration: '862_mcp_handoffs.sql', firstAfter: 863, serverMajor: 18 });
  });

  it('четырёхзначный номер и буква — граница по числу, не по строке', () => {
    expect(parseBaselineHeader(head(`${BASELINE_LAST_MIGRATION_LABEL} 1000_x.sql`)).firstAfter).toBe(1001);
    expect(parseBaselineHeader(head(`${BASELINE_LAST_MIGRATION_LABEL} 144b_x.sql`)).firstAfter).toBe(145);
  });

  it('строки нет — граница неизвестна (null), а не 863 и не 0', () => {
    const h = parseBaselineHeader(head('-- Baseline', `${BASELINE_SERVER_LABEL} PostgreSQL 16.4`));
    expect(h.lastMigration).toBeNull();
    expect(h.firstAfter).toBeNull();
    expect(h.serverMajor).toBe(16);
  });

  it('не имя файла миграции — не граница', () => {
    for (const v of ['862', '862_mcp_handoffs', 'mcp_handoffs.sql', '']) {
      expect(parseBaselineHeader(head(`${BASELINE_LAST_MIGRATION_LABEL} ${v}`)).firstAfter, v).toBeNull();
    }
  });

  it('метка ниже шапки не считается — в теле снимка ей не место', () => {
    const sql = ['-- Baseline', '', `${BASELINE_LAST_MIGRATION_LABEL} 862_x.sql`].join('\n');
    expect(parseBaselineHeader(sql).firstAfter).toBeNull();
  });

  it('версия: не PostgreSQL или без числа — неизвестна', () => {
    expect(serverMajorOf('неизвестен')).toBeNull();
    expect(serverMajorOf(null)).toBeNull();
    expect(serverMajorOf('PostgreSQL devel')).toBeNull();
    expect(serverMajorOf('PostgreSQL 9.6.24 on x86_64')).toBe(9);
  });
});

describe('шапка настоящего baseline', () => {
  const h = parseBaselineHeader(BASELINE);
  const migrations = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));

  it('граница записана и называет файл, который есть в каталоге', () => {
    expect(h.lastMigration, 'нет строки границы — шаблон pg-тестов не построится').not.toBeNull();
    expect(migrations).toContain(h.lastMigration);
  });

  it('версия сервера прода записана', () => {
    expect(h.serverMajor, 'нет строки «Сервер:» — не с чем сверить образ CI').not.toBeNull();
  });
});

describe('PostgreSQL в CI — той же мажорной версии, что прод', () => {
  interface Wf { jobs?: Record<string, { services?: Record<string, { image?: string }> }> }
  const WF_DIR = join(ROOT, '.github/workflows');
  const images: Array<{ where: string; image: string }> = [];
  for (const f of readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x))) {
    const doc = load(readFileSync(join(WF_DIR, f), 'utf8')) as Wf | null;
    for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
      for (const [svc, s] of Object.entries(def?.services ?? {})) {
        if (typeof s?.image === 'string' && /^postgres(:|$)/.test(s.image)) {
          images.push({ where: `${f} → ${job}.services.${svc}`, image: s.image });
        }
      }
    }
  }

  it('образ postgres в workflow найден — иначе сверять нечего', () => {
    expect(images.length).toBeGreaterThan(0);
    expect(images.some((i) => i.where.startsWith('ci.yml'))).toBe(true);
  });

  it('мажор образа равен мажору прода из шапки baseline', () => {
    // pg-тесты доказывают форму SQL на сервере; сервер другой мажорной версии
    // разбирает и выводит типы по-своему, и «прошло в CI» не значило бы
    // «пройдёт на проде». Тег без числа (latest) — не сверить, то есть красный.
    const prodMajor = parseBaselineHeader(BASELINE).serverMajor;
    for (const { where, image } of images) {
      const m = /^postgres:(\d+)/.exec(image);
      expect(m, `${where}: «${image}» — мажор не назван, сверить с продом нельзя`).not.toBeNull();
      expect(Number(m![1]), `${where}: «${image}», а прод — PostgreSQL ${prodMajor}`).toBe(prodMajor);
    }
  });
});

describe('сборщик baseline пишет границу сам (производитель строки)', () => {
  const ASSEMBLER = join(ROOT, 'scripts/assemble-db-baseline.py');
  /** Зовёт чистые функции сборщика: без сети и без секрета. */
  function assemble(dir: string): { last: string | null; header: string } {
    const py = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("assembler", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'last = m.last_migration(sys.argv[2])',
      'meta = {"server": "PostgreSQL 18.1 (Ubuntu 18.1-1.pgdg24.04+2) on x86_64-pc-linux-gnu", "counts": {"r": 1}}',
      'lines = m.header_lines(meta, last, {}, "2026-10-15T00:00:00+00:00")',
      'print(json.dumps({"last": last, "header": "\\n".join(lines)}))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', py, ASSEMBLER, dir], { encoding: 'utf8', env: { ...process.env, CRON_SECRET: '' } });
    return JSON.parse(out) as { last: string | null; header: string };
  }

  it('порядок тот же, что у migration-order: число, буква, имя; безномерные — не граница', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baseline-asm-'));
    try {
      const names = ['999_z.sql', '1000_b.sql', '1000a_c.sql', '100_a.sql', '144b_x.sql', 'noprefix.sql', 'README.md'];
      for (const n of names) writeFileSync(join(dir, n), '');
      const sqls = names.filter((n) => n.endsWith('.sql'));
      const numbered = sqls.filter((n) => !unnumberedMigrations([n]).length);
      const r = assemble(dir);
      expect(r.last).toBe(lastMigration(numbered));
      expect(r.last).toBe('1000a_c.sql');
      // Шапка сборщика читается разбором платформы — метки совпадают строка в строку.
      const h = parseBaselineHeader(`${r.header}\n\nCREATE TABLE x (id int);`);
      expect(h.lastMigration).toBe('1000a_c.sql');
      expect(h.firstAfter).toBe((migrationNumber('1000a_c.sql') ?? NaN) + 1);
      expect(h.serverMajor).toBe(18);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('пустой каталог — строки границы нет, а не выдуманное имя', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baseline-asm-'));
    try {
      const r = assemble(dir);
      expect(r.last).toBeNull();
      expect(r.header).not.toContain(BASELINE_LAST_MIGRATION_LABEL);
      expect(parseBaselineHeader(`${r.header}\n\nCREATE TABLE x (id int);`).firstAfter).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
