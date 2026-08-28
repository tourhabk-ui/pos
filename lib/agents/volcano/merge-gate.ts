/**
 * Volcano OS — merge-gate: единственный human gate системы.
 *
 * Оценивает готовность agent-PR к решению человека и ведёт видимые следы:
 * label `needs-owner-merge`, ОДИН sticky-комментарий (маркер
 * VOLCANO_CARD_MARKER, обновляется — не плодится), kernel-задача
 * code.merge и одно Telegram-сообщение владельцу на head_sha.
 *
 * Правила (задание владельца 27.08, части 3–4):
 * - готов = существует, помечен volcano-agent, НЕ draft, все проверки CI
 *   завершены и ни одна не провалена, head_sha карточки совпадает с
 *   текущим; красный или draft PR владельца НЕ беспокоит;
 * - новый commit в готовый PR снимает readiness (label долой, задача
 *   awaiting_merge → running); после зелёного CI карточка обновляется и
 *   допускается новое уведомление (dedup — по repo/pr/head_sha);
 * - ошибка Telegram НЕ меняет GitHub-readiness и не молчит (лог + ответ);
 * - workflow-будильник не имеет прав писать в репозиторий — все записи
 *   (label/комментарий) делает прод своим GITHUB_TOKEN, merge не делает
 *   НИКТО кроме человека.
 *
 * Judge здесь не выдумывается: разбор судьи в проекте repo-wide (evo-judge,
 * ежедневный выпуск), пер-PR вердикта у большинства PR нет — карточка
 * честно пишет «не привязан», а не сочиняет оценку (§4.0).
 *
 * ── unavailable ≠ rejected (P0, ревью 28.08) ─────────────────────────────────
 *
 * 27.08 прод отдал HTTP 500 "fetch failed" при вызове GitHub API — сетевой
 * сбой самого запроса, не решение GitHub о PR. Раньше это ничем не
 * отличалось от «наш код упал»: `gh()` бросал Error немедленно, без единой
 * попытки повтора, а вызывающий (route.ts) ловил это как `status: 'failed'`
 * — то же самое HTTP-тело получил бы владелец, если бы merge-gate реально
 * сломался. Разница важна: «не смогли спросить GitHub» не должно красить
 * прогон так же, как «спросили и получили отказ» — get-запрос без ответа не
 * значит «PR не готов», это «не знаю» (§4.0).
 *
 * `gh()` теперь различает СЕТЕВОЙ сбой (fetch() бросает раньше, чем пришёл
 * ответ — DNS, обрыв соединения) и 5xx GitHub (сервер ответил, но не смог) —
 * оба транзиентны и достойны короткого повтора с задержкой — от 4xx (401 не
 * авторизован, 404 не найден): это РЕШЕНИЕ, которое секунда ожидания не
 * изменит, повторять нечего. Если транзиентные попытки исчерпаны,
 * `GitHubUnavailableError` уходит наверх отдельным классом — route.ts и
 * sweepAgentPrs читают его явно, не строкой сообщения.
 */

import {
  completePr,
  ensureCodeMergeTask,
  findActiveCodeMergeTask,
  findAnyCodeMergeTask,
  markReady,
  markUnready,
  recordPrEventOnce,
} from '@/lib/agents/kernel/adapters/code-merge-task';
import { appendEvent } from '@/lib/agents/kernel';
import { pool } from '@/lib/db-pool';

export const VOLCANO_CARD_MARKER = '<!-- volcano-decision-card -->';
export const AGENT_PR_LABEL = 'volcano-agent';
export const DECISION_LABEL = 'needs-owner-merge';

/** GitHub недостижим после исчерпанных попыток — НЕ решение против PR. */
export class GitHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubUnavailableError';
  }
}

function ghHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'volcano-os-merge-gate',
  };
}

function repoBase(repo: string): string {
  return `https://api.github.com/repos/${repo}`;
}

/** Задержки между попытками — 3 попытки всего, короткий бюджет внутри HTTP-запроса. */
const RETRY_DELAYS_MS = [300, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GhAttemptOk<T> { ok: true; data: T }
interface GhAttemptFail { ok: false; transient: boolean; error: string }

/** Одна попытка. Сетевой throw и 5xx — transient (стоит повторить); 4xx — решение (не повторяем). */
async function ghAttempt<T>(repo: string, path: string, init?: RequestInit): Promise<GhAttemptOk<T> | GhAttemptFail> {
  let res: Response;
  try {
    res = await fetch(`${repoBase(repo)}${path}`, { ...init, headers: ghHeaders() });
  } catch (err) {
    return { ok: false, transient: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) return { ok: true, data: (await res.json()) as T };
  const body = await res.text().catch(() => '');
  const error = `GitHub ${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${body.slice(0, 200)}`;
  return { ok: false, transient: res.status >= 500, error };
}

async function gh<T>(repo: string, path: string, init?: RequestInit): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const result = await ghAttempt<T>(repo, path, init);
    if (result.ok) return result.data;
    lastError = result.error;
    if (!result.transient) throw new Error(result.error); // решение GitHub — повторять нечего
  }
  throw new GitHubUnavailableError(`${lastError} (после ${RETRY_DELAYS_MS.length + 1} попыток)`);
}

interface PrInfo {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  title: string;
  body: string | null;
  labels: string[];
  head_sha: string;
  html_url: string;
  changed_files: number;
  additions: number;
  deletions: number;
}

export async function fetchPr(repo: string, prNumber: number): Promise<PrInfo> {
  const raw = await gh<{
    number: number; state: 'open' | 'closed'; merged: boolean; draft: boolean;
    title: string; body: string | null; labels: Array<{ name: string }>;
    head: { sha: string }; html_url: string;
    changed_files: number; additions: number; deletions: number;
  }>(repo, `/pulls/${prNumber}`);
  return {
    number: raw.number,
    state: raw.state,
    merged: raw.merged,
    draft: raw.draft,
    title: raw.title,
    body: raw.body,
    labels: raw.labels.map((l) => l.name),
    head_sha: raw.head.sha,
    html_url: raw.html_url,
    changed_files: raw.changed_files,
    additions: raw.additions,
    deletions: raw.deletions,
  };
}

export interface ChecksState {
  total: number;
  pending: number;
  failed: number;
  green: boolean;
}

/** Проверки head-коммита: зелёный = все завершены, ни одной проваленной, есть хоть одна. */
export async function fetchChecks(repo: string, headSha: string): Promise<ChecksState> {
  const raw = await gh<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(
    repo, `/commits/${headSha}/check-runs?per_page=100`,
  );
  let pending = 0; let failed = 0;
  for (const c of raw.check_runs) {
    if (c.status !== 'completed') { pending += 1; continue; }
    if (c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)) failed += 1;
  }
  return {
    total: raw.total_count,
    pending,
    failed,
    green: raw.total_count > 0 && pending === 0 && failed === 0,
  };
}

/** Раздел из тела PR по заголовку (## Риск / ## Откат); null — не описан. */
export function extractSection(body: string | null, titles: string[]): string | null {
  if (!body) return null;
  for (const t of titles) {
    const re = new RegExp(`^##+\\s*${t}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'im');
    const m = body.match(re);
    if (m && m[1].trim().length > 0) return m[1].trim().slice(0, 400);
  }
  return null;
}

export interface DecisionCardInput {
  pr: PrInfo;
  repo: string;
  taskId: string;
  traceId: string;
  checks: ChecksState;
  migrations: string[];
}

/** Текст sticky-карточки. Только факты; отсутствующее названо отсутствующим. */
export function buildDecisionCard(input: DecisionCardInput): string {
  const { pr, checks } = input;
  const risk = extractSection(pr.body, ['Риск', 'Risk']) ?? 'не описан в PR — считать не ниже medium';
  const rollback = extractSection(pr.body, ['Откат', 'Rollback'])
    ?? 'git revert squash-коммита; миграции идемпотентны и обратной миграции не требуют, если ниже не сказано иное';
  const judge = extractSection(pr.body, ['Judge', 'Судья']) ?? 'не привязан (разбор судьи в проекте repo-wide, выпуск ежедневный)';
  return [
    VOLCANO_CARD_MARKER,
    '## Volcano OS просит принять решение',
    '',
    `PR: ${pr.html_url}`,
    `Kernel task: \`${input.taskId}\` · trace: \`${input.traceId}\``,
    '',
    `**Что изменено:** ${pr.title}`,
    `**Diff:** ${pr.changed_files} файлов, +${pr.additions}/−${pr.deletions}`,
    `**CI:** ${checks.green ? `passed (${checks.total} проверок)` : `НЕ зелёный (${checks.failed} провалено, ${checks.pending} идёт)`}`,
    `**Judge:** ${judge}`,
    `**Риск:** ${risk}`,
    `**Миграции:** ${input.migrations.length > 0 ? input.migrations.join(', ') : 'нет'}`,
    `**Откат:** ${rollback}`,
    `**Head:** \`${pr.head_sha}\``,
    '',
    '**Решение владельца:** Merge или Close/Reject в GitHub. Больше ничего делать не нужно.',
    '',
    '---',
    '_Generated by [Claude Code](https://claude.ai/code)_',
  ].join('\n');
}

/** Создаёт или ОБНОВЛЯЕТ единственный комментарий с маркером. */
async function upsertCard(repo: string, prNumber: number, body: string): Promise<void> {
  const comments = await gh<Array<{ id: number; body: string }>>(
    repo, `/issues/${prNumber}/comments?per_page=100`,
  );
  const existing = comments.find((c) => c.body.includes(VOLCANO_CARD_MARKER));
  if (existing) {
    await gh(repo, `/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  } else {
    await gh(repo, `/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  }
}

async function addLabel(repo: string, prNumber: number, label: string): Promise<void> {
  await gh(repo, `/issues/${prNumber}/labels`, { method: 'POST', body: JSON.stringify({ labels: [label] }) });
}

async function removeLabel(repo: string, prNumber: number, label: string): Promise<void> {
  await fetch(`${repoBase(repo)}/issues/${prNumber}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE', headers: ghHeaders(),
  }).catch(() => undefined); // отсутствующий label — не ошибка
}

/** Файлы миграций в diff — человеку важно видеть их до merge. */
async function listMigrations(repo: string, prNumber: number): Promise<string[]> {
  const files = await gh<Array<{ filename: string }>>(repo, `/pulls/${prNumber}/files?per_page=100`);
  return files.map((f) => f.filename).filter((f) => f.startsWith('migrations/'));
}

/**
 * Telegram владельцу — ровно один раз на head_sha (dedup держит kernel-
 * событие note/kind=telegram). Отказ TG не меняет readiness и не молчит.
 */
async function notifyOwnerOnce(
  repo: string, pr: PrInfo, taskId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const deduped = await recordPrEventOnce(taskId, 'note', {
    repo, pr: pr.number, head_sha: pr.head_sha, kind: 'telegram',
  });
  if (!deduped) return { sent: false, reason: 'уже уведомляли об этом head_sha' };

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID;
  if (!token || !chatId) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN/TELEGRAM_OWNER_ID не настроены' };

  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: 'HTML',
        text: [
          '<b>Volcano OS: PR готов к вашему решению</b>',
          '',
          `${pr.title}`,
          `Файлов: ${pr.changed_files} · +${pr.additions}/−${pr.deletions} · CI зелёный`,
          '',
          `<a href="${pr.html_url}">Открыть PR #${pr.number}</a> — Merge или Close, больше ничего.`,
        ].join('\n'),
      }),
    });
    if (!res.ok) return { sent: false, reason: `Telegram HTTP ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface GateOutcome {
  pr: number;
  action:
    | 'skipped_not_agent_pr'
    | 'completed_merged'
    | 'completed_closed'
    | 'ready_notified'
    | 'ready_already'
    | 'unready'
    | 'waiting_ci'
    /** GitHub был недостижим после retry — НЕ решение против PR (P0, ревью 28.08). */
    | 'github_unavailable';
  detail?: string;
  taskId?: string;
}

/** Один PR: оценить и привести всё в соответствие. Идемпотентно. */
export async function evaluatePr(repo: string, prNumber: number): Promise<GateOutcome> {
  const pr = await fetchPr(repo, prNumber);

  if (!pr.labels.includes(AGENT_PR_LABEL)) {
    return { pr: prNumber, action: 'skipped_not_agent_pr' };
  }

  // ── Закрыт: замкнуть задачу, снять label ────────────────────────────────
  if (pr.state === 'closed') {
    const task = await findAnyCodeMergeTask(repo, prNumber)
      ?? await ensureCodeMergeTask(repo, prNumber, pr.title);
    const done = await completePr(task, pr.merged ? 'merged' : 'closed', {
      repo, pr: prNumber, head_sha: pr.head_sha,
    });
    await removeLabel(repo, prNumber, DECISION_LABEL);
    return {
      pr: prNumber,
      action: pr.merged ? 'completed_merged' : 'completed_closed',
      taskId: task.id,
      detail: done.changed ? `задача → ${done.state}` : `уже ${done.state}`,
    };
  }

  const task = await findActiveCodeMergeTask(repo, prNumber)
    ?? await ensureCodeMergeTask(repo, prNumber, pr.title);
  await recordPrEventOnce(task.id, 'pr_opened', { repo, pr: prNumber, head_sha: pr.head_sha, kind: 'seen' });

  const checks = await fetchChecks(repo, pr.head_sha);
  const ready = !pr.draft && checks.green;

  if (!ready) {
    const un = await markUnready(task, pr.draft ? 'PR в draft' : `CI: провалено ${checks.failed}, идёт ${checks.pending}`);
    if (un.changed) {
      await removeLabel(repo, prNumber, DECISION_LABEL);
      return { pr: prNumber, action: 'unready', taskId: task.id, detail: un.reason ?? 'readiness снят' };
    }
    return { pr: prNumber, action: 'waiting_ci', taskId: task.id, detail: `draft=${pr.draft}, failed=${checks.failed}, pending=${checks.pending}` };
  }

  // ── Готов: задача awaiting_merge, label, карточка, Telegram ─────────────
  const migrations = await listMigrations(repo, prNumber);
  const became = await markReady(task, pr.head_sha, { checks: checks.total });
  await addLabel(repo, prNumber, DECISION_LABEL);
  await upsertCard(repo, prNumber, buildDecisionCard({
    pr, repo, taskId: task.id, traceId: task.trace_id, checks, migrations,
  }));

  const tg = await notifyOwnerOnce(repo, pr, task.id);
  if (!tg.sent && tg.reason && !tg.reason.startsWith('уже уведомляли')) {
    // Отказ канала не отменяет readiness, но остаётся в журнале задачи.
    await appendEvent(task.id, 'cron:merge-gate', 'note', { telegram_failed: tg.reason });
  }

  return {
    pr: prNumber,
    action: tg.sent ? 'ready_notified' : 'ready_already',
    taskId: task.id,
    detail: became.changed ? 'задача → awaiting_merge' : `уведомление: ${tg.reason ?? 'отправлено'}`,
  };
}

/** Sweep: все открытые agent-PR + недобитые awaiting_merge из ядра. */
export async function sweepAgentPrs(repo: string): Promise<GateOutcome[]> {
  const open = await gh<Array<{ number: number }>>(
    repo, `/issues?labels=${AGENT_PR_LABEL}&state=open&per_page=50`,
  );
  const numbers = new Set(open.map((i) => i.number));

  // Задачи, застрявшие в awaiting_merge/running, чей PR мог закрыться без
  // callback'а (webhook потерян): добираем из ядра.
  const { rows } = await pool.query<{ resource_id: string }>(
    `SELECT resource_id FROM agent_tasks
     WHERE capability = 'code.merge' AND state IN ('running','awaiting_merge')
       AND resource_id LIKE $1
     LIMIT 50`,
    [`${repo}#%`],
  );
  for (const r of rows) {
    const n = parseInt(r.resource_id.split('#')[1] ?? '', 10);
    if (!Number.isNaN(n)) numbers.add(n);
  }

  const outcomes: GateOutcome[] = [];
  for (const n of numbers) {
    try {
      outcomes.push(await evaluatePr(repo, n));
    } catch (err) {
      if (err instanceof GitHubUnavailableError) {
        // Транзиентная недоступность GitHub — не «ошибка оценки»: этот PR
        // просто не проверен сейчас, следующий sweep через 30 мин подхватит.
        outcomes.push({ pr: n, action: 'github_unavailable', detail: err.message });
        continue;
      }
      outcomes.push({ pr: n, action: 'waiting_ci', detail: `ошибка оценки: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return outcomes;
}
