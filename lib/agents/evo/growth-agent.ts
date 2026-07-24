/**
 * Growth Agent — сканирует здоровье проекта.
 * Находит: мёртвый код, дыры безопасности, tech debt, баги, UX-проблемы.
 * Записывает в evo_growth_issues для последующей эволюции.
 */

import { pool } from '@/lib/db-pool';
import { callAIDecision } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';
import { isCredibleFinding, verifyAgainstSource } from '@/lib/agents/evo/finding-guard';
import { selectReviewTargets, loadLedger, recordReviewed } from '@/lib/agents/evo/coverage-ledger';
import { listRepoFiles, clientComponentPaths, getLastListSource, type RepoFilesSource } from '@/lib/agents/evo/repo-files';
import { detectMockPatterns } from '@/lib/agents/evo/mock-detector';

export interface GrowthIssue {
  category: 'dead_code' | 'security' | 'performance' | 'bug' | 'tech_debt' | 'ux';
  severity: 'critical' | 'high' | 'medium' | 'low';
  file_path?: string;
  line_number?: number;
  title: string;
  description: string;
  suggestion: string;
}

/**
 * Наблюдаемость прочёса: без неё ответ скана — чёрный ящик, где «0 проблем»
 * неотличимо от «не прочитал ни одного файла». На проде (standalone без
 * исходников) это отличие критично: source='none' → GitHub недостижим из РФ и
 * весь sweep пуст, а не «всё чисто».
 */
export interface ScanCoverage {
  /** Откуда взят перечень файлов: disk | github | none. */
  source: RepoFilesSource;
  /** Сколько ревьюибельных .ts-файлов вообще перечислено. */
  files_listed: number;
  /** Сколько файлов реально прочитано и отдано аудитору (тело получено). */
  files_reviewed: number;
  /** Сколько клиент-компонентов прочёсано мок-детектором. */
  mock_files_scanned: number;
}

export interface GrowthScanResult {
  issues: GrowthIssue[];
  /** Сколько из найденных проблем НОВЫЕ (впервые записаны в БД этим сканом). */
  new_issues: number;
  scan_id: string;
  duration_ms: number;
  /** Что скан реально прочитал (диагностика глубины прочёса). */
  coverage: ScanCoverage;
}

// ── Code-level scans ─────────────────────────────────────────────────────

/**
 * AI false-positive exclusions — файлы которые Gemini помечает ложно.
 * Все проверены вручную: секреты через env, SQL параметризованы.
 */
const AI_EXCLUDED_FILES = new Set([
  'lib/payments/tochka.ts',           // все секреты через process.env
  'lib/bookings/booking.service.ts',  // все SQL параметризованы ($1, $2...)
]);

/**
 * Security issues которые приняты осознанно — не баг, а архитектурное решение.
 * Evo не должен их репортить каждый скан.
 */
const ACCEPTED_RISKS = new Set([
  'app/api/webhook/route.ts',         // exec() защищён HMAC-SHA256, команда захардкожена
]);

/**
 * Подтверждённые мёртвые модули (0 импортов). Список — ручной, поэтому
 * каждая запись обязана существовать в репо: тест evo-scan-honesty
 * проверяет existsSync по каждому пути. Прод исполняет standalone-бандл
 * без исходников, так что проверить existsSync в рантайме нельзя —
 * актуальность держится на этом тесте.
 *
 * История: аудит 2026-04-24 нашёл 13 модулей; к июлю 2026 десять удалены,
 * а experiment-tracker (wilsonInterval в eval), context-hub и
 * observation-logger (platform-agent) снова используются. Список пуст —
 * новые записи добавлять только после ручной проверки «grep = 0 импортов».
 */
export const DEAD_MODULES: string[] = [];

async function scanDeadCode(): Promise<GrowthIssue[]> {
  return DEAD_MODULES.map(f => ({
    category: 'dead_code' as const,
    severity: 'low' as const,
    file_path: f,
    title: `Мёртвый модуль: ${f.split('/').pop()}`,
    description: `${f} — 0 импортов, не используется.`,
    suggestion: 'Удалить файл или подключить к рабочему процессу.',
  }));
}

async function scanSecurity(): Promise<GrowthIssue[]> {
  const issues: GrowthIssue[] = [];

  // GitHub webhook — known risk, accepted (HMAC + hardcoded cmd)
  // Skip — it's in ACCEPTED_RISKS

  return issues;
}

/**
 * Известный tech debt. Как и DEAD_MODULES — ручной список, каждая запись
 * обязана указывать на существующий файл (тест evo-scan-honesty).
 * run-089/run-115 удалены из репо — записи сняты, фантомы в БД закрывает
 * миграция 743.
 */
export const TECH_DEBT_FILES: Array<Pick<GrowthIssue, 'file_path' | 'title' | 'description' | 'suggestion'>> = [];

async function scanTechDebt(): Promise<GrowthIssue[]> {
  return TECH_DEBT_FILES.map(t => ({
    category: 'tech_debt' as const,
    severity: 'medium' as const,
    ...t,
  }));
}

async function scanPerformance(): Promise<GrowthIssue[]> {
  const issues: GrowthIssue[] = [];

  // Check for missing indexes on hot tables
  try {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_name IN ('operator_bookings', 'agent_memory', 'ai_actions_log')
        AND c.column_name IN ('created_at', 'booking_status', 'agent_id')
        AND NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE tablename = c.table_name
            AND indexdef LIKE '%' || c.column_name || '%'
        )
      LIMIT 10
    `);

    for (const r of rows) {
      issues.push({
        category: 'performance',
        severity: 'medium',
        file_path: 'migrations/',
        title: `Нет индекса: ${r.table_name}.${r.column_name}`,
        description: `Колонка ${r.column_name} в ${r.table_name} часто фильтруется но без индекса.`,
        suggestion: `Добавить CREATE INDEX idx_${r.table_name}_${r.column_name} ON ${r.table_name}(${r.column_name}).`,
      });
    }
  } catch {
    // DB might not have the tables yet
  }

  return issues;
}

// ── AI analysis of code quality ────────────────────────────────────────────

// Ответы модели без содержимого/с отговорками — не проблемы, в БД не пишем.
// 12.07: в evo_growth_issues лежали «Файл не предоставлен для анализа» и
// выдуманные строки кода — модель получала только ИМЕНА файлов.
const AI_REVIEW_GARBAGE = /не предоставлен|невозможно подтвердить|пропускаю|нет информации о файле|file not provided/i;

// На один файл не копим парафразы одной и той же претензии
const MAX_OPEN_ISSUES_PER_FILE = 2;

const MAX_FILE_CHARS = 24_000;

function clampForReview(text: string): string {
  return text.length > MAX_FILE_CHARS
    ? text.slice(0, MAX_FILE_CHARS) + '\n// ... (обрезано для ревью)'
    : text;
}

// Прод — standalone-образ без исходников .ts, поэтому диск -> фоллбэк на
// GitHub raw (репо публичный). Без содержимого файл не ревьюится вовсе.
async function readFileForReview(relPath: string): Promise<string | null> {
  try {
    const [fs, path] = await Promise.all([import('fs'), import('path')]);
    const full = path.join(process.cwd(), relPath);
    if (fs.existsSync(full)) return clampForReview(fs.readFileSync(full, 'utf8'));
  } catch { /* фоллбэк ниже */ }

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/tourhabk-ui/pos/main/${relPath}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    return clampForReview(await res.text());
  } catch {
    return null;
  }
}

// Ядро — ревьюим всегда: самые чувствительные пути (создание брони + мозг
// Кузьмича), даже если давно не менялись.
const CORE_REVIEW_FILES = [
  'app/api/hub/bookings/create/route.ts',
  'lib/kuzmich/core.ts',
  // excluded: lib/payments/tochka.ts (env vars, verified)
  // excluded: lib/bookings/booking.service.ts (parameterized SQL, verified)
];

// Сильный аудитор (Claude Opus 4.8) тянет больше файлов за прогон; прогон
// off-peak, поэтому шире окно = быстрее прочёс всей платформы. Было 4.
const MAX_REVIEW_FILES = 8;
const REVIEW_REPO_SLUG = 'tourhabk-ui/pos';

/**
 * Путь стоит ревью: исходник с логикой (app/api или lib), не тест/декларация,
 * не в списках исключений/принятых рисков. Экспортируется для guard-теста.
 */
export function isReviewableSourcePath(p: string): boolean {
  if (!p.endsWith('.ts')) return false;
  if (p.endsWith('.d.ts') || p.includes('.test.') || p.includes('__tests__')) return false;
  if (!(p.startsWith('app/api/') || p.startsWith('lib/'))) return false;
  if (AI_EXCLUDED_FILES.has(p) || ACCEPTED_RISKS.has(p)) return false;
  return true;
}

/** Union ядра и недавно изменённых: дедуп, ядро первым, обрезка до max. */
export function pickReviewFiles(core: string[], recent: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...core, ...recent]) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Недавно изменённые исходники через GitHub compare API. Сервер (РФ/Timeweb)
 * достаёт raw.githubusercontent — та же инфраструктура, что api.github.com.
 * Без токена лимит 60 req/hr, а скан раз в 6ч — с запасом. Ошибка/пусто → [],
 * тогда ревьюим только ядро (прежнее поведение). Раньше сканер видел 2
 * зашитых файла из 600+ — весь новый код (safety-ingest, MAX, planner…) не
 * попадал под ревью вообще (EVO-4).
 */
async function recentlyChangedSourceFiles(windowCommits = 12): Promise<string[]> {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'kamchatour-evo' };
    const listRes = await fetch(
      `https://api.github.com/repos/${REVIEW_REPO_SLUG}/commits?per_page=${windowCommits}&sha=main`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!listRes.ok) return [];
    const commits = await listRes.json() as Array<{ sha: string }>;
    if (!Array.isArray(commits) || commits.length < 2) return [];
    const base = commits[commits.length - 1].sha;
    const head = commits[0].sha;
    const cmpRes = await fetch(
      `https://api.github.com/repos/${REVIEW_REPO_SLUG}/compare/${base}...${head}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!cmpRes.ok) return [];
    const cmp = await cmpRes.json() as { files?: Array<{ filename: string; status: string }> };
    const files = (cmp.files ?? [])
      .filter(f => f.status !== 'removed')
      .map(f => f.filename)
      .filter(isReviewableSourcePath);
    return Array.from(new Set(files));
  } catch {
    return [];
  }
}

interface CodeReviewResult {
  issues: GrowthIssue[];
  listed: number;
  reviewed: number;
  source: RepoFilesSource;
}

async function aiCodeReview(): Promise<CodeReviewResult> {
  // Леджер покрытия: систематический прочёс всей платформы, а не 2 ядровых
  // файла. candidates = все ревьюибельные .ts; selectReviewTargets берёт churn +
  // невиданные/давно-невиданные (по риску). Fallback на скользящее окно, если
  // список файлов не достали (GitHub недоступен).
  const recent = await recentlyChangedSourceFiles();
  const allFiles = await listRepoFiles();
  const source = getLastListSource();
  const candidates = allFiles.filter(isReviewableSourcePath);
  let reviewFiles: string[];
  if (candidates.length > 0) {
    const ledger = await loadLedger(pool).catch(() => []);
    reviewFiles = selectReviewTargets({
      candidates,
      ledger,
      recentChanged: [...CORE_REVIEW_FILES, ...recent].filter((f) => candidates.includes(f)),
      now: Date.now(),
      max: MAX_REVIEW_FILES,
    });
  } else {
    reviewFiles = pickReviewFiles(CORE_REVIEW_FILES, recent, MAX_REVIEW_FILES);
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты ведущий аудитор безопасности и качества кода платформы TourHab — туризм Камчатки, главная цель — безопасность туристов (карта, SOS, маршруты работают офлайн).
Стек: Next.js 15 App Router, TypeScript strict, PostgreSQL (прямой параметризованный SQL через pg), свой JWT.

ЖЁСТКИЕ ПРАВИЛА (нарушение = находка будет отброшена детерминированным стражем):
1. В проекте НЕТ Prisma, НЕТ ORM, НЕТ NextAuth/getServerSession. Аутентификация — verifyToken/extractToken/requireAuth/requireAdmin/requireRole. Транзакции/блокировки — сырой SQL (BEGIN, SELECT ... FOR UPDATE). НИКОГДА не предлагай Prisma-транзакции, getServerSession и прочий чужой стек — это провал аудита.
2. Прежде чем писать «отсутствует X» (try/catch, проверка auth, блокировка), НАЙДИ X в приведённом коде. Если в файле есть try{ }/catch, verifyToken/requireAuth, FOR UPDATE — этого X НЕ не хватает, находки нет.
3. Каждая находка ОБЯЗАНА ссылаться на конкретную строку показанного кода (поле line). Не видишь строки — не выдумывай находку. Если файл чист — верни пустой массив [].
4. Не заводи несколько парафраз одной претензии по одному файлу.

Ищи проблемы ТОЛЬКО этих типов, в порядке приоритета:
1. SQL-инъекции: конкатенация строк вместо $1,$2 — critical
2. Дыры авторизации: защищённый route без requireAuth/requireAdmin/requireRole — critical
3. Утечки ресурсов: pool.connect() без release() в finally — high
4. Race conditions: чтение-модификация-запись БД без транзакции (особенно брони, tour_availability) — high
5. Внешний вызов (AI, БД, payments, telegram) без try/catch — medium
6. Нарушения конвенций: import default pool вместо import { pool }; обращение к устаревшим bookings/tours вместо operator_bookings/operator_tours; отладочный console-вывод в проде; прямой callDeepSeek вместо callAIWaterfall — medium

severity: critical = утечка данных/обход auth/инъекция/поломка платежей или SOS; high = потеря данных/падение под нагрузкой; medium = деградация/нарушение конвенций; low = косметика.

Отвечай СТРОГО JSON-массивом без markdown:
[{"file":"path","line":123,"title":"≤8 слов","description":"что сломано и при каком сценарии","severity":"critical|high|medium|low","suggestion":"какую конструкцию заменить и на что"}]
Максимум 5 проблем. Только реально подтверждаемые — если файл чист, не выдумывай. Без слов "возможно/рекомендуется в целом" — только факт и следствие.

Исключённые файлы (проверены вручную, НЕ репорти):
- lib/payments/tochka.ts — все секреты через process.env
- lib/bookings/booking.service.ts — все SQL параметризованы ($1, $2)
- app/api/webhook/route.ts — exec() защищён HMAC, команда захардкожена`,
    },
  ];

  // Содержимое файлов ОБЯЗАТЕЛЬНО: до 12.07 модель получала только имена
  // и выдумывала «проблемы» («import pool from '@/lib/db' строка 60»,
  // «callDeepSeek без try/catch» — ничего из этого в коде не было)
  const fileBlocks: string[] = [];
  // Держим содержимое по пути — для верификационного прохода (сверка находки
  // «отсутствует X» с реальным телом файла).
  const fileContents = new Map<string, string>();
  for (const f of reviewFiles) {
    const content = await readFileForReview(f);
    if (content) {
      fileBlocks.push(`━━━ ${f} ━━━\n${content}`);
      fileContents.set(f, content);
    }
  }
  if (fileBlocks.length === 0) {
    return { issues: [], listed: candidates.length, reviewed: 0, source };
  }

  messages.push({
    role: 'user',
    content: `Проверь файлы на проблемы из системного промпта (инъекции, auth, утечки ресурсов, race conditions, отсутствие try/catch, нарушения конвенций проекта). Содержимое файлов ниже — ссылайся только на код, который реально видишь, с точными строками.\n\n${fileBlocks.join('\n\n')}`,
  });

  try {
    // Сильный решатель: DeepSeek (последний) → Qwen (последний), достижимы из РФ
    const result = await callAIDecision(messages);
    if (!result) {
      return { issues: [], listed: candidates.length, reviewed: fileBlocks.length, source };
    }

    const jsonStr = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(jsonStr) as Array<{
      file: string; title: string; description: string;
      severity: string; suggestion: string;
    }>;

    // Filter out excluded files (AI may still mention them) + мусор-ответы +
    // недостоверные находки (страж: клеймят санкционированный callAIFast/
    // console.error нарушением, или «X вместо X» — см. finding-guard).
    const filtered = parsed.filter(p =>
      !AI_EXCLUDED_FILES.has(p.file) &&
      !ACCEPTED_RISKS.has(p.file) &&
      !AI_REVIEW_GARBAGE.test(`${p.title} ${p.description}`) &&
      isCredibleFinding({ title: p.title, description: p.description, suggestion: p.suggestion }) &&
      // Верификационный проход: «отсутствует try/catch/auth/блокировка», когда
      // в теле файла они ЕСТЬ — ложь (кейс booking-роута). Сверяем с исходником.
      verifyAgainstSource(
        { title: p.title, description: p.description, suggestion: p.suggestion },
        fileContents.get(p.file),
      ) === null,
    );

    const mapped: GrowthIssue[] = filtered.map(p => ({
      category: 'bug' as const,
      severity: (p.severity as GrowthIssue['severity']) || 'medium',
      file_path: p.file,
      title: p.title,
      description: p.description,
      suggestion: p.suggestion,
    }));

    // Фиксируем покрытие: какие файлы посмотрели и сколько находок каждый дал.
    const findingsByFile: Record<string, number> = {};
    for (const m of mapped) if (m.file_path) findingsByFile[m.file_path] = (findingsByFile[m.file_path] ?? 0) + 1;
    await recordReviewed(pool, findingsByFile, reviewFiles).catch(() => {});

    return { issues: mapped, listed: candidates.length, reviewed: fileBlocks.length, source };
  } catch {
    return { issues: [], listed: candidates.length, reviewed: fileBlocks.length, source };
  }
}

/**
 * Мок-детектор: детерминированный прочёс клиент-компонентов на фейк-витрины
 * (мок-данные, кнопки-пустышки). Ротация покрытия по тому же леджеру — за
 * несколько прогонов обходит все экраны. Не тратит LLM.
 */
// Каждый файл — GitHub-raw запрос; держим сумму (review + mock + tree) под
// лимитом 60/час. За несколько прогонов ротация покрытия обходит все экраны.
const MAX_MOCK_FILES = 12;

async function scanMocks(): Promise<{ issues: GrowthIssue[]; scanned: number }> {
  const all = await listRepoFiles();
  const clients = clientComponentPaths(all);
  if (clients.length === 0) return { issues: [], scanned: 0 };

  const ledger = await loadLedger(pool).catch(() => []);
  const targets = selectReviewTargets({
    candidates: clients, ledger, recentChanged: [], now: Date.now(), max: MAX_MOCK_FILES,
  });

  const issues: GrowthIssue[] = [];
  const reviewed: string[] = [];
  const findingsByFile: Record<string, number> = {};
  for (const f of targets) {
    const content = await readFileForReview(f);
    reviewed.push(f);
    if (!content) continue;
    const found = detectMockPatterns(f, content);
    for (const it of found) {
      issues.push(it);
      findingsByFile[f] = (findingsByFile[f] ?? 0) + 1;
    }
  }
  await recordReviewed(pool, findingsByFile, reviewed).catch(() => {});
  return { issues, scanned: reviewed.length };
}

// ── Main scan orchestrator ────────────────────────────────────────────────

export async function runGrowthScan(scanType: string = 'full'): Promise<GrowthScanResult> {
  const start = Date.now();
  const issues: GrowthIssue[] = [];
  const coverage: ScanCoverage = {
    source: 'none', files_listed: 0, files_reviewed: 0, mock_files_scanned: 0,
  };

  if (scanType === 'full' || scanType === 'code') {
    const [dead, debt] = await Promise.all([scanDeadCode(), scanTechDebt()]);
    issues.push(...dead, ...debt);
  }

  if (scanType === 'full' || scanType === 'security') {
    issues.push(...await scanSecurity());
  }

  if (scanType === 'full' || scanType === 'performance') {
    issues.push(...await scanPerformance());
  }

  if (scanType === 'full') {
    const review = await aiCodeReview();
    issues.push(...review.issues);
    coverage.source = review.source;
    coverage.files_listed = review.listed;
    coverage.files_reviewed = review.reviewed;
    // Детерминированный объектив на фейк-витрины (мок-данные, кнопки-пустышки).
    const mocks = await scanMocks().catch(() => ({ issues: [] as GrowthIssue[], scanned: 0 }));
    issues.push(...mocks.issues);
    coverage.mock_files_scanned = mocks.scanned;
  }

  // Save scan result
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO evo_growth_scans (scan_type, status, issues_found, duration_ms, summary)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id`,
    [scanType, issues.length, Date.now() - start, `Найдено ${issues.length} проблем`],
  );
  const scanId = rows[0]?.id ?? '';

  // Save individual issues — deduplicate by file_path+title
  let newIssues = 0;
  for (const issue of issues) {
    // Check if this exact issue already exists (any active status — not just 'open').
    // Without this, issues re-appear every scan after Evolution Loop moves them to 'accepted'.
    const { rows: existing } = await pool.query<{ id: string }>(
      `SELECT id FROM evo_growth_issues
       WHERE status NOT IN ('rejected', 'ignored')
         AND file_path = $1
         AND title = $2
       LIMIT 1`,
      [issue.file_path ?? null, issue.title],
    );

    if (existing.length > 0) {
      // Already exists — skip, just log the scan reference
      continue;
    }

    // Дедуп по file+title не ловит парафразы одной претензии («Нет try/catch
    // внешнего вызова» × 4 формулировки) — жёсткий кап на файл
    if (issue.file_path) {
      const { rows: sameFile } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM evo_growth_issues
         WHERE status IN ('open', 'suggested') AND file_path = $1 AND category = $2`,
        [issue.file_path, issue.category],
      );
      if ((sameFile[0]?.n ?? 0) >= MAX_OPEN_ISSUES_PER_FILE) continue;
    }

    await pool.query(
      `INSERT INTO evo_growth_issues (scan_id, category, severity, file_path, line_number, title, description, suggestion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [scanId, issue.category, issue.severity, issue.file_path ?? null, issue.line_number ?? null, issue.title, issue.description, issue.suggestion],
    );
    newIssues++;
  }

  // Atomic increment — safe under parallel execution with evolution-loop.
  // value — JSONB (migration 151): извлекаем скаляр как текст (#>>'{}'),
  // инкрементим и упаковываем обратно в jsonb.
  await pool.query(
    `UPDATE evo_agent_state SET value = to_jsonb((value#>>'{}')::int + 1), updated_at = NOW() WHERE key = 'cycle_count'`,
  );
  await pool.query(
    `UPDATE evo_agent_state SET value = $1::jsonb, updated_at = NOW() WHERE key = 'last_scan_at'`,
    [JSON.stringify(new Date().toISOString())],
  );

  return { issues, new_issues: newIssues, scan_id: scanId, duration_ms: Date.now() - start, coverage };
}

