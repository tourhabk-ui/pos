/**
 * scripts/evo-judge-publish.ts
 *
 * Публикация отчёта судьи — идемпотентно, по ОДНОМУ каноническому Issue на
 * `report_key`, а не по новому выпуску на каждую доставку одного и того же
 * анализа. Разбирает задание владельца 27.08 («идемпотентный Judge-report»):
 * `schedule`, marker `push` и ручной прогон разбирают один и тот же снимок
 * находок, доставленный по-разному — планировщик GitHub деградирует и
 * доставляет очередь с многочасовым опозданием (27.08: marker в 09:07,
 * запоздавший scheduled в 17:38, вход не изменился). Раньше каждый успешный
 * прогон безусловно заводил новый GitHub Issue.
 *
 * ── Три момента, а не один ─────────────────────────────────────────────────
 *
 * 1. ЗАПУСК workflow — сколько угодно раз, историю каждого держат artifacts.
 * 2. ВХОД анализа (`input_hash`, scripts/evo-judge.ts) — определяет, нужно
 *    ли снова тратить токены LLM. Совпал и не force_refresh — модель не
 *    зовём вовсе (этот модуль решает это ДО модели, см. checkDuplicate).
 * 3. ПРОЕКЦИЯ для владельца — один канонический GitHub Issue, обновляемый на
 *    месте. Публикует и решает publish-or-reuse этот модуль.
 *
 * GitHub-операции — за инъецируемым `GhClient`: реальная имплементация
 * (`createRestGhClient`) зовёт REST напрямую (как lib/agents/volcano/
 * merge-gate.ts — тот же паттерн `fetch` + `GITHUB_TOKEN`, никакого `gh` CLI
 * в тестируемой логике), а тесты подставляют фейковый клиент в памяти.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import {
  prepareJudgeInput,
  hashJudgeInput,
  reportKey,
  type Finding,
  type ReportMeta,
} from './evo-judge';

// ── Скрытый маркер канонического Issue ──────────────────────────────────────

export const REPORT_LABEL = 'evo-judge-report';
/** Метка совместимости: под ней же живут находки другого рода (issue-reporter). */
export const LEGACY_LABEL = 'evo';

export interface JudgeMarker {
  schema: 1;
  report_key: string;
  input_hash: string;
  output_hash: string;
  decision_hash: string;
  actionable: number;
  source_run_id: string;
  analysis_status: 'complete' | 'degraded';
}

const MARKER_RE = /<!-- volcano:evo-judge-report (\{.*?\}) -->/;

export function buildMarker(m: JudgeMarker): string {
  return `<!-- volcano:evo-judge-report ${JSON.stringify(m)} -->`;
}

/** null — маркера нет ИЛИ он не разбирается: Issue тогда не читается как канонический этого report_key. */
export function parseMarker(body: string | null): JudgeMarker | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as Partial<JudgeMarker>;
    if (parsed && typeof parsed === 'object' && parsed.report_key && parsed.input_hash) {
      return parsed as JudgeMarker;
    }
    return null;
  } catch {
    return null;
  }
}

// ── GitHub client: инъецируемый, реальный REST поверх него ──────────────────

export interface GhIssueLite {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
}

export interface GhClient {
  listIssuesByLabel(label: string): Promise<GhIssueLite[]>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<GhIssueLite>;
  updateIssue(number: number, patch: { body?: string; state?: 'open' | 'closed'; state_reason?: 'completed' }): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'volcano-evo-judge-publish',
  };
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<string | { name: string }>;
  pull_request?: unknown;
}

/** Реальная имплементация — REST напрямую, без `gh` CLI: то же решение, что у merge-gate.ts. */
export function createRestGhClient(repo: string, token: string): GhClient {
  const base = `https://api.github.com/repos/${repo}`;
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, { ...init, headers: ghHeaders(token) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
  const toLite = (i: RawIssue): GhIssueLite => ({
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  });
  return {
    async listIssuesByLabel(label) {
      // state=all: закрытый выпуск прошлого дня остаётся каноническим для
      // своего report_key, пока не появится новое решение — «Заменено» этому
      // отчёту не нужно, он и так один.
      const raw = await req<RawIssue[]>(`/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`);
      return raw.filter((i) => !('pull_request' in i)).map(toLite);
    },
    async createIssue({ title, body, labels }) {
      const raw = await req<RawIssue>('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels }) });
      return toLite(raw);
    },
    async updateIssue(number, patch) {
      await req(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    async addComment(number, body) {
      await req(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    },
  };
}

// ── Канонический Issue: минимальный номер среди одноимённых report_key ──────

export interface CanonicalLookup {
  canonical: { issue: GhIssueLite; marker: JudgeMarker } | null;
  /** Исторические дубли того же report_key — появляются, если публикация когда-то гонялась параллельно. */
  duplicates: GhIssueLite[];
}

export async function findCanonical(client: GhClient, key: string): Promise<CanonicalLookup> {
  const issues = await client.listIssuesByLabel(REPORT_LABEL);
  const matches = issues
    .map((issue) => ({ issue, marker: parseMarker(issue.body) }))
    .filter((x): x is { issue: GhIssueLite; marker: JudgeMarker } => !!x.marker && x.marker.report_key === key)
    .sort((a, b) => a.issue.number - b.issue.number);
  if (matches.length === 0) return { canonical: null, duplicates: [] };
  const [canonical, ...rest] = matches;
  return { canonical, duplicates: rest.map((r) => r.issue) };
}

// ── Шаг 1: решить, нужен ли вызов модели вообще ──────────────────────────────

export interface DedupCheck {
  skip: boolean;
  reportKey: string;
  inputHash: string;
  forceRefresh: boolean;
  canonicalIssueNumber: number | null;
}

/**
 * Тот же вход, тот же канонический Issue, не degraded и не force_refresh —
 * останавливаемся ДО модели. `degraded` намеренно НЕ участвует в пропуске
 * (задание 27.08, п.10): немой прогон обязан попытаться снова, а не застрять
 * тем же неполным разбором навсегда.
 */
export async function checkDuplicate(
  client: GhClient,
  key: string,
  inputHash: string,
  forceRefresh: boolean,
): Promise<DedupCheck> {
  const lookup = await findCanonical(client, key);
  const canonical = lookup.canonical;
  const skip = !forceRefresh
    && canonical !== null
    && canonical.marker.input_hash === inputHash
    && canonical.marker.analysis_status !== 'degraded';
  return {
    skip,
    reportKey: key,
    inputHash,
    forceRefresh,
    canonicalIssueNumber: canonical?.issue.number ?? null,
  };
}

// ── Шаг 2: публикация-или-переиспользование ──────────────────────────────────

export type PublishAction =
  | 'created'
  | 'no_issue_needed'
  | 'no_change'
  | 'body_updated'
  | 'decision_changed'
  | 'closed_clean'
  | 'reopened_actionable';

export interface PublishInput {
  client: GhClient;
  reportKey: string;
  title: string;
  bodyWithoutMarker: string;
  inputHash: string;
  outputHash: string;
  decisionHash: string;
  actionable: number;
  sourceRunId: string;
  analysisStatus: 'complete' | 'degraded';
}

export interface PublishResult {
  action: PublishAction;
  issueNumber: number | null;
  closedDuplicates: number[];
}

const FOOTER = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_';
const DUP_NOTE = `Дубль этого выпуска — канонический номер стоит в связанном Issue.${FOOTER}`;
const REOPEN_NOTE = `Появились новые решения, требующие внимания, — выпуск переоткрыт.${FOOTER}`;
const CHANGED_NOTE = `Изменился набор решений, ожидающих внимания.${FOOTER}`;

/**
 * Публикует ровно в канонический Issue своего `report_key` — создаёт, если
 * его нет и есть что показать; иначе обновляет тело на месте и решает
 * comment/reopen/close только по изменению `decision_hash` (не `output_hash`
 * и не `input_hash` — иначе стилистически иной `reason` читался бы как новое
 * решение). Исторические дубли (если появились) закрываются каждый вызов.
 */
export async function publishJudgeReport(input: PublishInput): Promise<PublishResult> {
  const lookup = await findCanonical(input.client, input.reportKey);

  const closedDuplicates: number[] = [];
  for (const dup of lookup.duplicates) {
    if (dup.state === 'open') {
      await input.client.addComment(dup.number, DUP_NOTE);
      await input.client.updateIssue(dup.number, { state: 'closed', state_reason: 'completed' });
    }
    closedDuplicates.push(dup.number);
  }

  const marker: JudgeMarker = {
    schema: 1,
    report_key: input.reportKey,
    input_hash: input.inputHash,
    output_hash: input.outputHash,
    decision_hash: input.decisionHash,
    actionable: input.actionable,
    source_run_id: input.sourceRunId,
    analysis_status: input.analysisStatus,
  };
  const fullBody = `${input.bodyWithoutMarker}\n\n${buildMarker(marker)}`;

  if (!lookup.canonical) {
    if (input.actionable === 0) {
      return { action: 'no_issue_needed', issueNumber: null, closedDuplicates };
    }
    const created = await input.client.createIssue({ title: input.title, body: fullBody, labels: [REPORT_LABEL, LEGACY_LABEL] });
    return { action: 'created', issueNumber: created.number, closedDuplicates };
  }

  const { issue, marker: prev } = lookup.canonical;

  if (prev.decision_hash === input.decisionHash) {
    if (prev.input_hash === input.inputHash && prev.output_hash === input.outputHash) {
      // Отпечаток не изменился ни в чём — GitHub не трогаем вовсе.
      return { action: 'no_change', issueNumber: issue.number, closedDuplicates };
    }
    await input.client.updateIssue(issue.number, { body: fullBody });
    return { action: 'body_updated', issueNumber: issue.number, closedDuplicates };
  }

  if (input.actionable === 0) {
    await input.client.updateIssue(issue.number, { body: fullBody, state: 'closed', state_reason: 'completed' });
    return { action: 'closed_clean', issueNumber: issue.number, closedDuplicates };
  }

  const wasClosed = issue.state === 'closed';
  await input.client.updateIssue(issue.number, wasClosed ? { body: fullBody, state: 'open' } : { body: fullBody });
  await input.client.addComment(issue.number, wasClosed ? REOPEN_NOTE : CHANGED_NOTE);
  return { action: wasClosed ? 'reopened_actionable' : 'decision_changed', issueNumber: issue.number, closedDuplicates };
}

// ── CLI: две команды, обе зовутся из .github/workflows/evo-judge.yml ────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} не задан — без него шаг работать не может`);
  return v;
}

async function cliCheck(days: number, findingsPath: string, forceRefresh: boolean, outPath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(findingsPath, 'utf-8')) as { issues?: Finding[] };
  const all = Array.isArray(raw.issues) ? raw.issues : [];
  const prepared = prepareJudgeInput(all, { days });
  const inputHash = hashJudgeInput(prepared);
  const key = reportKey(days);

  const repo = requireEnv('GITHUB_REPOSITORY');
  const token = requireEnv('GITHUB_TOKEN');
  const client = createRestGhClient(repo, token);
  const check = await checkDuplicate(client, key, inputHash, forceRefresh);

  writeFileSync(outPath, JSON.stringify(check, null, 2));
  console.log(`report_key=${key} input_hash=${inputHash} skip=${check.skip} canonical=${check.canonicalIssueNumber ?? 'нет'}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && check.skip) {
    appendFileSync(summary, `\nJudge: вход не изменился (\`${key}\`) — LLM не вызывался, Issue #${check.canonicalIssueNumber} не тронут.\n`);
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `skip_llm=${check.skip}\n`);
}

async function cliPublish(checkPath: string, reportPath: string | undefined, metaPath: string | undefined, outPath: string): Promise<void> {
  const check = JSON.parse(readFileSync(checkPath, 'utf-8')) as DedupCheck;
  const repo = requireEnv('GITHUB_REPOSITORY');
  const token = requireEnv('GITHUB_TOKEN');
  const client = createRestGhClient(repo, token);
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`;

  if (check.skip) {
    const result: PublishResult = { action: 'no_change', issueNumber: check.canonicalIssueNumber, closedDuplicates: [] };
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`duplicate_input: Issue #${check.canonicalIssueNumber ?? '(нет)'} не тронут, LLM не вызывался`);
    return;
  }

  if (!reportPath || !metaPath) {
    throw new Error('publish: без skip нужны report.md и meta.json — судья должен был отработать');
  }
  const body = readFileSync(reportPath, 'utf-8');
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ReportMeta;

  const result = await publishJudgeReport({
    client,
    reportKey: meta.report_key,
    title: meta.title,
    bodyWithoutMarker: body,
    inputHash: meta.input_hash,
    outputHash: meta.output_hash,
    decisionHash: meta.decision_hash,
    actionable: meta.actionable,
    sourceRunId: runUrl,
    analysisStatus: meta.analysis_status,
  });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`publish: ${result.action} → issue ${result.issueNumber ?? '(нет)'}; закрыто дублей: ${result.closedDuplicates.length}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `\nJudge report: ${result.action} → Issue #${result.issueNumber ?? '(нет)'}.\n`);
}

async function cli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'check') {
    const [daysRaw, findingsPath, outPath] = rest;
    const days = parseInt(daysRaw ?? '', 10) || 7;
    const forceRefresh = (process.env.FORCE_REFRESH ?? '').trim().toLowerCase() === 'true';
    if (!findingsPath || !outPath) throw new Error('check: использование check <дни> <находки.json> <check.json>');
    await cliCheck(days, findingsPath, forceRefresh, outPath);
    return;
  }
  if (cmd === 'publish') {
    const [checkPath, reportPath, metaPath, outPath] = rest;
    if (!checkPath || !outPath) throw new Error('publish: использование publish <check.json> [отчёт.md] [meta.json] <result.json>');
    await cliPublish(checkPath, reportPath, metaPath, outPath);
    return;
  }
  throw new Error(`Неизвестная команда: ${cmd ?? '(нет)'}. Ожидается check или publish.`);
}

if (process.argv[1] && process.argv[1].endsWith('evo-judge-publish.ts')) {
  cli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
