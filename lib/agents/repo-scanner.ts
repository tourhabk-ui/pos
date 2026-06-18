/**
 * lib/agents/repo-scanner.ts
 *
 * Agent Repo Scanner — три параллельных зонда для ежедневного брифинга:
 *   scanDbSchema()         — drift-детектор: колонки в БД + последние миграции
 *   scanRepoTree()         — полное дерево репо через GitHub API (git trees recursive)
 *   scanProductionHealth() — публичные GET-эндпоинты: статус + latency (таймаут 5s)
 *
 * Агрегатор runRepoScan() запускает все три параллельно и пишет результат
 * в agent_knowledge (slug='repo-scan/YYYY-MM-DD', type='repo-state').
 */

import { pool } from '@/lib/db-pool';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';

const GITHUB_REPO = 'tourhabk-ui/pos';
const GITHUB_API  = 'https://api.github.com';

// Публичные эндпоинты для health probe — только GET, без auth, без нагрузки
const PROD_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vedarai.ru';
const PUBLIC_ENDPOINTS = [
  '/api/public/safety-status',
  '/api/safety/geofence-zones',
  '/api/safety/seismic',
  '/api/safety/volcanic',
  '/api/safety/weather',
  '/api/cron/health',
  '/api/public/now',
  '/api/routes/list',
  '/api/places/list',
  '/api/public/danger-summary',
] as const;

export interface RepoScanResult {
  dbSummary: string;
  repoSummary: string;
  healthSummary: string;
  tablesScanned: number;
  filesFound: number;
  endpointsChecked: number;
  generatedAt: string;
}

interface ColumnRow {
  table_name: string;
  column_count: string;
}

interface MigrationRow {
  name: string;
  applied_at: string;
}

interface TreeItem {
  path: string;
  type: string;
}

interface GitTreeResponse {
  tree: TreeItem[];
  truncated: boolean;
}

// ── Зонд 1: схема БД ──────────────────────────────────────────────────────────

export async function scanDbSchema(): Promise<{ summary: string; tablesScanned: number }> {
  try {
    const [colRows, migRows] = await Promise.all([
      pool.query<ColumnRow>(`
        SELECT table_name, COUNT(*)::text AS column_count
        FROM information_schema.columns
        WHERE table_schema = 'public'
        GROUP BY table_name
        ORDER BY table_name
      `),
      pool.query<MigrationRow>(`
        SELECT name, applied_at::text
        FROM _migrations
        ORDER BY applied_at DESC
        LIMIT 10
      `).catch(() => ({ rows: [] as MigrationRow[] })),
    ]);

    const tableLines = colRows.rows
      .map(r => `  ${r.table_name} (${r.column_count} col)`)
      .join('\n');

    const lastMigration = migRows.rows[0]?.name ?? 'неизвестно';
    const migLines = migRows.rows
      .slice(0, 5)
      .map(r => `  ${r.name}`)
      .join('\n');

    const summary = [
      `Таблиц в БД: ${colRows.rows.length} | Последняя миграция: ${lastMigration}`,
      `Последние миграции:\n${migLines}`,
      `Все таблицы:\n${tableLines}`,
    ].join('\n');

    return { summary, tablesScanned: colRows.rows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: `Ошибка сканирования БД: ${msg}`, tablesScanned: 0 };
  }
}

// ── Зонд 2: дерево репо ───────────────────────────────────────────────────────

export async function scanRepoTree(): Promise<{ summary: string; filesFound: number }> {
  try {
    const token = process.env.GITHUB_ISSUES_TOKEN;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const url = `${GITHUB_API}/repos/${GITHUB_REPO}/git/trees/main?recursive=1`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { summary: `GitHub tree API: ${res.status} ${res.statusText}`, filesFound: 0 };
    }

    const data = (await res.json()) as GitTreeResponse;
    const files = data.tree.filter(item => item.type === 'blob');

    // Фильтруем по ключевым директориям
    const APP_API = files.filter(f => f.path.startsWith('app/api/') && f.path.endsWith('route.ts'));
    const COMPONENTS = files.filter(f => f.path.startsWith('components/'));
    const LIB_AGENTS = files.filter(f => f.path.startsWith('lib/agents/'));
    const MIGRATIONS = files.filter(f => f.path.startsWith('migrations/'));

    const summary = [
      `Файлов в репо: ${files.length}${data.truncated ? ' (обрезан)' : ''}`,
      `API routes: ${APP_API.length} | Компонентов: ${COMPONENTS.length} | Агентов: ${LIB_AGENTS.length} | Миграций: ${MIGRATIONS.length}`,
      '',
      `=== API маршруты (${APP_API.length}) ===`,
      APP_API.map(f => `  ${f.path}`).join('\n'),
      '',
      `=== Агенты (${LIB_AGENTS.length}) ===`,
      LIB_AGENTS.map(f => `  ${f.path}`).join('\n'),
      '',
      `=== Последние миграции ===`,
      MIGRATIONS.slice(-10).map(f => `  ${f.path}`).join('\n'),
    ].join('\n');

    return { summary, filesFound: files.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: `Ошибка сканирования репо: ${msg}`, filesFound: 0 };
  }
}

// ── Зонд 3: production health ─────────────────────────────────────────────────

export async function scanProductionHealth(): Promise<{ summary: string; endpointsChecked: number }> {
  const results = await Promise.allSettled(
    PUBLIC_ENDPOINTS.map(async endpoint => {
      const start = Date.now();
      try {
        const res = await fetch(`${PROD_BASE}${endpoint}`, {
          signal: AbortSignal.timeout(5_000),
          headers: { Accept: 'application/json' },
        });
        const latency = Date.now() - start;
        return { endpoint, ok: res.ok, status: res.status, latency };
      } catch (err) {
        const latency = Date.now() - start;
        const msg = err instanceof Error ? err.message.slice(0, 40) : 'timeout';
        return { endpoint, ok: false, status: 0, latency, error: msg };
      }
    })
  );

  const lines = results.map(r => {
    if (r.status === 'fulfilled') {
      const { endpoint, ok, status, latency, error } = r.value as {
        endpoint: string; ok: boolean; status: number; latency: number; error?: string;
      };
      const icon = ok ? 'OK' : 'ERR';
      const err = error ? ` (${error})` : '';
      return `  ${icon} ${endpoint} — ${status || 'timeout'} ${latency}ms${err}`;
    }
    return `  ERR (rejected)`;
  });

  const okCount = results.filter(
    r => r.status === 'fulfilled' && (r.value as { ok: boolean }).ok
  ).length;

  const summary = [
    `Production health: ${okCount}/${PUBLIC_ENDPOINTS.length} OK`,
    ...lines,
  ].join('\n');

  return { summary, endpointsChecked: PUBLIC_ENDPOINTS.length };
}

// ── Агрегатор ─────────────────────────────────────────────────────────────────

export async function runRepoScan(gitLog?: string): Promise<RepoScanResult> {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [dbResult, repoResult, healthResult] = await Promise.all([
      scanDbSchema(),
      scanRepoTree(),
      scanProductionHealth(),
    ]);

    const sections = [
      `Дата скана: ${today}`,
      '',
      '=== СХЕМА БД ===',
      dbResult.summary,
      '',
      '=== ДЕРЕВО РЕПО ===',
      repoResult.summary,
      '',
      '=== PRODUCTION HEALTH ===',
      healthResult.summary,
    ];
    if (gitLog) {
      sections.push('', '=== ПОСЛЕДНИЕ КОММИТЫ ===', gitLog.slice(0, 1000));
    }

    const compiledTruth = sections.join('\n');

    await knowledgeBase.upsert({
      slug: `repo-scan/${today}`,
      type: 'repo-state',
      title: `Состояние репо ${today}`,
      compiled_truth: compiledTruth,
      metadata: {
        tables_scanned: dbResult.tablesScanned,
        files_found: repoResult.filesFound,
        endpoints_checked: healthResult.endpointsChecked,
        generated_at: new Date().toISOString(),
      },
      agent_id: 'repo-scanner',
    });

    return {
      dbSummary: dbResult.summary,
      repoSummary: repoResult.summary,
      healthSummary: healthResult.summary,
      tablesScanned: dbResult.tablesScanned,
      filesFound: repoResult.filesFound,
      endpointsChecked: healthResult.endpointsChecked,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorSummary = `[REPO SCAN FAILED ${today}: ${msg}]`;

    // Пишем явную failure-запись — агент должен видеть "упал", а не пустоту
    await knowledgeBase.upsert({
      slug: `repo-scan/${today}`,
      type: 'repo-state',
      title: `Состояние репо ${today} [ОШИБКА]`,
      compiled_truth: errorSummary,
      metadata: { error: true, error_msg: msg, generated_at: new Date().toISOString() },
      agent_id: 'repo-scanner',
    }).catch(() => {});

    return {
      dbSummary: '[DB ЗОНД НЕДОСТУПЕН]',
      repoSummary: '[GITHUB ЗОНД НЕДОСТУПЕН]',
      healthSummary: '[HEALTH ЗОНД НЕДОСТУПЕН]',
      tablesScanned: 0,
      filesFound: 0,
      endpointsChecked: 0,
      generatedAt: new Date().toISOString(),
    };
  }
}
