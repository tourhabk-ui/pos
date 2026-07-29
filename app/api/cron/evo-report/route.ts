/**
 * Рука эволюции → GitHub Issues (интерфейс для GitHub Actions раннера).
 *
 * GET  /api/cron/evo-report?secret=<CRON_SECRET>
 *   → находки Growth Scan в статусе 'suggested', ещё не вынесенные в issue,
 *     с готовыми title/body (детерминированно, без модели). Раннер
 *     (scripts/evo-report-issues.js) заводит по ним GitHub Issues.
 *
 * POST /api/cron/evo-report?secret=<CRON_SECRET>
 *   body { reported: [{ id, issue_url }] }
 *   → проставляет github_issue_url, чтобы следующий прогон не дублировал.
 *
 * Раннер живёт на GitHub (не на Timeweb) → RF-блокировки не мешают gh/API.
 * Никаких изменений кода — только заведение задач в трекер (безопасно, обратимо).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { buildIssueTitle, buildIssueBody, selectReportable, type GrowthFinding } from '@/lib/agents/evo/issue-reporter';
import { verifyAgainstSource } from '@/lib/agents/evo/finding-guard';
import { decidePublish, applyPublishDecision } from '@/lib/agents/evo/precision';
import { githubFetch } from '@/lib/agents/evo/github-fetch';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const REPORT_LIMIT = 10; // не заваливаем трекер за один прогон

/**
 * Обратная связь: закрытые человеком issues → находки помечаются 'rejected'.
 * Без этого вердикт человека уходил в пустоту — сегодня закрыл десять ложных,
 * завтра пришли те же десять. Теперь каждая закрытая задача делает следующий
 * прогон умнее (стоп-лист по классу претензии в growth-agent).
 */
async function syncClosedIssues(): Promise<number> {
  const { rows } = await pool.query<{ id: string; github_issue_url: string }>(`
    SELECT id, github_issue_url FROM evo_growth_issues
     WHERE github_issue_url IS NOT NULL
       AND status NOT IN ('rejected', 'ignored', 'fixed')
     LIMIT 30
  `);
  if (rows.length === 0) return 0;

  const closed: string[] = [];
  for (const r of rows) {
    const num = r.github_issue_url.match(/\/issues\/(\d+)/)?.[1];
    if (!num) continue;
    try {
      const res = await githubFetch(
        `https://api.github.com/repos/tourhabk-ui/pos/issues/${num}`,
        { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kamchatour-evo' }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) continue;
      const issue = await res.json() as { state?: string; state_reason?: string };
      // Закрыт как «не будем делать» = вердикт «находка не годится».
      if (issue.state === 'closed' && issue.state_reason === 'not_planned') closed.push(r.id);
    } catch { /* сеть — пропускаем, попробуем в следующий прогон */ }
  }

  if (closed.length > 0) {
    await pool.query(
      `UPDATE evo_growth_issues SET status = 'rejected', resolved_at = NOW() WHERE id = ANY($1::uuid[])`,
      [closed],
    ).catch(() => {});
  }
  return closed.length;
}

/** Тело файла из репозитория (для сверки находки с живым кодом). null — не достали. */
async function fetchSource(relPath: string): Promise<string | null> {
  try {
    const res = await githubFetch(
      `https://raw.githubusercontent.com/tourhabk-ui/pos/main/${relPath}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Сначала подбираем вердикты человека (закрытые issues), потом публикуем —
  // иначе отвергнутое успеет попасть в выборку этого же прогона.
  const synced = await syncClosedIssues().catch(() => 0);

  // Цена ошибки: если точность просела, догадки модели не публикуем.
  const { rows: pr } = await pool.query<{ accepted: string; rejected: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('accepted', 'fixed'))::text    AS accepted,
      COUNT(*) FILTER (WHERE status IN ('rejected', 'ignored'))::text  AS rejected
    FROM evo_growth_issues
  `);
  const decision = decidePublish({
    accepted: Number(pr[0]?.accepted ?? 0),
    rejected: Number(pr[0]?.rejected ?? 0),
  });

  // Разрез по моделям: проверяемо ли «врут слабые фоллбэк-модели». Waterfall
  // молча съезжает с флагмана на DeepSeek/Qwen, и без этой таблицы гипотеза
  // остаётся спором. Пусто, пока не накопятся находки с атрибуцией.
  const { rows: byModel } = await pool.query<{ model: string | null; accepted: string; rejected: string }>(`
    SELECT model,
           COUNT(*) FILTER (WHERE status IN ('accepted', 'fixed'))::text   AS accepted,
           COUNT(*) FILTER (WHERE status IN ('rejected', 'ignored'))::text AS rejected
      FROM evo_growth_issues
     WHERE model IS NOT NULL
     GROUP BY model
     ORDER BY COUNT(*) DESC
     LIMIT 10
  `).catch(() => ({ rows: [] as Array<{ model: string | null; accepted: string; rejected: string }> }));

  const precisionByModel = byModel.map((r) => {
    const a = Number(r.accepted); const rj = Number(r.rejected);
    return {
      model: r.model,
      accepted: a,
      rejected: rj,
      precision: a + rj > 0 ? Number((a / (a + rj)).toFixed(2)) : null,
    };
  });

  const { rows } = await pool.query<GrowthFinding & { status: string }>(`
    -- model: кто породил находку. Без него в тикете не видно, дал её флагман
    -- или waterfall тихо съехал на фоллбэк, — а тихое понижение выглядит ровно
    -- как здоровье (см. buildIssueBody).
    SELECT id, category, severity, file_path, line_number, title, description, suggestion, status, model
    FROM evo_growth_issues
    WHERE status = 'suggested'
      AND github_issue_url IS NULL
      AND severity <> 'low'
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 50
  `);

  // Сверка с ЖИВЫМ исходником перед публикацией. Инцидент 24.07: наружу ушли
  // 10 issues про booking-роут — «нет requireAuth/try-catch/FOR UPDATE», хотя в
  // файле есть всё три. Страж стоял только на входе (скан), выход публиковал
  // что лежит в БД, включая до-стражевый мусор. Не прошедшее сверку помечаем
  // 'rejected' — оно больше не всплывёт (БД самоочищается).
  const sourceCache = new Map<string, string | null>();
  const verified: typeof rows = [];
  const rejected: string[] = [];

  for (const f of rows) {
    if (!f.file_path) { verified.push(f); continue; }

    let src = sourceCache.get(f.file_path);
    if (src === undefined) {
      src = await fetchSource(f.file_path);
      sourceCache.set(f.file_path, src);
    }
    // Исходник не достали — не судим (иначе при недоступном GitHub отбросим всё).
    if (src === null) { verified.push(f); continue; }

    const reason = verifyAgainstSource(
      { title: f.title, description: f.description ?? '', suggestion: f.suggestion ?? '' },
      src,
    );
    if (reason) rejected.push(f.id);
    else verified.push(f);
  }

  if (rejected.length > 0) {
    await pool.query(
      `UPDATE evo_growth_issues SET status = 'rejected', resolved_at = NOW() WHERE id = ANY($1::uuid[])`,
      [rejected],
    ).catch(() => { /* чистка некритична для публикации */ });
  }

  // Догадки модели гасим при просевшей точности; детерминированные находки
  // (static-checks, мок-детектор, разведка) идут всегда — они не гадают.
  const publishable = applyPublishDecision(verified, decision);

  const issues = selectReportable(publishable, REPORT_LIMIT).map((f) => ({
    id: f.id,
    title: buildIssueTitle(f),
    body: buildIssueBody(f),
    severity: f.severity,
    category: f.category,
  }));

  return NextResponse.json({
    success: true,
    count: issues.length,
    // Видно, сколько мусора отсеяно за прогон — «0 issues» перестаёт быть немым.
    rejected_by_guard: rejected.length,
    // Обратная связь и цена ошибки — наблюдаемы, а не скрыты.
    synced_closed_issues: synced,
    precision: decision.precision,
    guesses_allowed: decision.allowGuesses,
    precision_note: decision.reason,
    // Кто именно врёт: точность в разрезе моделей-авторов находок.
    precision_by_model: precisionByModel,
    issues,
  });
}

const ReportedSchema = z.object({
  reported: z
    .array(z.object({ id: z.string().uuid(), issue_url: z.string().url().max(500) }))
    .max(50)
    .optional()
    .default([]),
});

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ReportedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'reported[] required' },
      { status: 400 },
    );
  }

  let updated = 0;
  for (const item of parsed.data.reported) {
    // Только если ещё не помечено — не перетираем ссылку от предыдущего прогона.
    const res = await pool.query(
      `UPDATE evo_growth_issues
         SET github_issue_url = $2
       WHERE id = $1 AND github_issue_url IS NULL`,
      [item.id, item.issue_url],
    );
    updated += res.rowCount ?? 0;
  }

  return NextResponse.json({ success: true, updated });
}
