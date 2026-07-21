#!/usr/bin/env node
/**
 * Evo — рука действия (детерминированный применятель).
 *
 * Читает pending-правки с прода (/api/cron/evo-apply), применяет ТОЛЬКО
 * детерминированное к рабочему дереву репозитория и пишет манифест. Git,
 * tsc, черновой PR и колбэк-пометку делает workflow (.github/workflows/
 * evo-apply.yml) — так каждый шаг виден в логе и гейтится отдельно.
 *
 * Применяем два вида правок:
 *   add_index   → новая идемпотентная миграция migrations/NNN_evo_idx_*.sql
 *                 (CREATE INDEX CONCURRENTLY IF NOT EXISTS — вне транзакции,
 *                 project migrate-runner это понимает);
 *   delete_file → удаление подтверждённо-мёртвого файла (если существует).
 *
 * Раннер на GitHub Actions, не на Timeweb → RF-блокировки не мешают.
 * Никаких AI-вызовов и git apply произвольных диффов: только детерминизм.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROD_URL = process.env.TOURHAB_URL || 'https://vedarai.ru';
const CRON_SECRET = process.env.CRON_SECRET || '';
const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');
const MANIFEST_PATH = path.join(REPO_ROOT, 'evo-apply-manifest.json');

// Дублируем предохранитель из lib/agents/evo/deterministic-fix.ts: сервер уже
// фильтрует, но раннер пишет в файловую систему — вторая линия обязательна.
const PROTECTED_PATHS = [
  'lib/auth/', 'lib/payments/', 'app/api/webhook/',
  'app/api/payments/', 'app/api/safety/sos', 'middleware.ts', '.env',
];
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

function log(stage, message, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage, message, ...data }));
}

function isProtected(p) {
  return !p || PROTECTED_PATHS.some((prefix) => p.includes(prefix));
}

function nextMigrationNumber() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f));
  let max = 0;
  for (const f of files) {
    const n = parseInt(f.match(/^(\d+)_/)[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// Уже есть индекс с таким именем в любой миграции? Тогда пропускаем (in_progress
// пометка защищает от повтора, это — вторая линия против дубля файла).
function indexAlreadyDefined(indexName) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  return files.some((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').includes(indexName));
}

function indexMigrationSql(table, column) {
  const name = `idx_${table}_${column}`;
  return `-- Evo auto-fix: индекс под частый фильтр без покрытия (Growth Scan).
-- Идемпотентно; CONCURRENTLY → migrate-runner выполняет вне транзанции.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
  ON ${table} (${column});
`;
}

async function fetchPending() {
  const res = await fetch(`${PROD_URL}/api/cron/evo-apply`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET evo-apply → HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.fixes) ? data.fixes : [];
}

async function main() {
  if (!CRON_SECRET) {
    log('ERROR', 'CRON_SECRET не задан');
    process.exit(1);
  }

  let pending;
  try {
    pending = await fetchPending();
  } catch (e) {
    // Эндпоинт мог быть ещё не задеплоен (окно Timeweb) или временно недоступен.
    // Для фоновой автоматизации это не повод краснить job — пустой манифест, exit 0.
    log('WARN', 'Не удалось получить pending-правки — пустой прогон', { error: String(e) });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ count: 0, shipped_ids: [], noop_ids: [], summary: [] }, null, 2));
    return;
  }

  log('EVO_APPLY', `Получено pending-правок: ${pending.length}`);

  const shippedIds = []; // реальные изменения файлов — идут в PR
  const noopIds = [];    // уже применено ранее — закрываем без PR
  const summary = [];
  let nextNum = nextMigrationNumber();

  for (const item of pending) {
    const fix = item.fix || {};
    try {
      if (fix.kind === 'add_index') {
        const { table, column } = fix;
        if (!IDENT_RE.test(table || '') || !IDENT_RE.test(column || '')) {
          log('SKIP', 'add_index: недопустимый идентификатор', { table, column });
          continue;
        }
        const indexName = `idx_${table}_${column}`;
        if (indexAlreadyDefined(indexName)) {
          log('NOOP', 'add_index: индекс уже определён в миграциях', { indexName });
          noopIds.push(item.id);
          continue;
        }
        const num = String(nextNum++).padStart(3, '0');
        const file = `${num}_evo_${indexName}.sql`;
        fs.writeFileSync(path.join(MIGRATIONS_DIR, file), indexMigrationSql(table, column));
        shippedIds.push(item.id);
        summary.push(`+ индекс \`${indexName}\` → migrations/${file}`);
        log('APPLY', 'add_index', { file });
      } else if (fix.kind === 'delete_file') {
        const rel = fix.path;
        if (isProtected(rel)) {
          log('SKIP', 'delete_file: защищённый путь', { path: rel });
          continue;
        }
        const abs = path.join(REPO_ROOT, rel);
        if (!abs.startsWith(REPO_ROOT + path.sep)) {
          log('SKIP', 'delete_file: путь вне репозитория', { path: rel });
          continue;
        }
        if (fs.existsSync(abs)) {
          fs.rmSync(abs);
          shippedIds.push(item.id);
          summary.push(`- удалён мёртвый файл \`${rel}\``);
          log('APPLY', 'delete_file', { path: rel });
        } else {
          log('NOOP', 'delete_file: файла нет (уже удалён)', { path: rel });
          noopIds.push(item.id);
        }
      } else {
        log('SKIP', 'неизвестный вид правки', { kind: fix.kind });
      }
    } catch (e) {
      log('ERROR', 'Ошибка применения правки', { id: item.id, error: String(e) });
    }
  }

  const manifest = {
    count: summary.length,   // реальные изменения файлов (→ PR открывается только при >0)
    shipped_ids: shippedIds, // записи, вошедшие в PR (закрыть с pr_url)
    noop_ids: noopIds,       // уже применённые ранее (закрыть без PR)
    summary,                 // человекочитаемо для тела PR
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  log('EVO_APPLY', `Готово: изменений=${manifest.count}, в PR=${shippedIds.length}, noop=${noopIds.length}`);
}

main().catch((e) => {
  log('ERROR', 'Fatal', { error: String(e) });
  process.exit(1);
});
