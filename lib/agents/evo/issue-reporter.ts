/**
 * Рука эволюции → GitHub Issues.
 *
 * Чистый модуль (формат заголовка/тела + фильтр), без сети и без БД —
 * тестируется на фикстурах. Раннер (scripts/evo-report-issues.js) на GitHub
 * Actions берёт из /api/cron/evo-report готовые title/body и заводит issue;
 * POST-колбэк проставляет github_issue_url, чтобы не плодить дубли.
 *
 * Детерминизм: title/body строятся из полей находки, без участия модели.
 */

export interface GrowthFinding {
  id: string;
  category: string;
  severity: string;
  file_path: string | null;
  line_number: number | null;
  title: string;
  description: string | null;
  suggestion: string | null;
}

/** Только реальные severity; всё прочее приравниваем к 'medium'. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.medium;
}

/**
 * Стоит ли заводить issue по находке. Заводим только 'suggested' (Evolution
 * Loop уже решил, что авто-фикс не выходит — нужен человек) и не 'low'
 * (косметику в трекер не выносим — шум). Уже вынесенные (есть issue_url)
 * фильтруются на уровне SQL, здесь — смысловой порог.
 */
export function isReportable(f: Pick<GrowthFinding, 'severity'> & { status?: string; github_issue_url?: string | null }): boolean {
  if (f.github_issue_url) return false;
  if (f.status && f.status !== 'suggested') return false;
  return f.severity !== 'low';
}

/** Заголовок issue: стабилен по одной и той же находке — служит и ключом дедупа. */
export function buildIssueTitle(f: Pick<GrowthFinding, 'category' | 'severity' | 'title'>): string {
  const sev = SEVERITY_RANK[f.severity] !== undefined ? f.severity : 'medium';
  // Ограничиваем длину: заголовки GitHub до ~256, но держим коротко и читаемо.
  const core = f.title.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `[evo/${f.category}] ${core} (${sev})`;
}

/** Тело issue в Markdown. Footer с id находки — для трассировки и дедупа. */
export function buildIssueBody(f: GrowthFinding): string {
  const lines: string[] = [];
  lines.push(`**Категория:** \`${f.category}\` · **Severity:** \`${f.severity}\``);
  if (f.file_path) {
    lines.push(`**Файл:** \`${f.file_path}${f.line_number ? `:${f.line_number}` : ''}\``);
  }
  lines.push('');
  if (f.description) {
    lines.push(f.description.trim());
    lines.push('');
  }
  if (f.suggestion) {
    lines.push('**Предложение:**');
    lines.push('');
    lines.push(f.suggestion.trim());
    lines.push('');
  }
  lines.push('---');
  lines.push(`_Заведено автоматически рукой эволюции (Evo Growth Scan). Находка \`${f.id}\`._`);
  return lines.join('\n');
}

/** Отсортированные по severity (critical → low) и обрезанные до limit находки. */
export function selectReportable(findings: GrowthFinding[], limit: number): GrowthFinding[] {
  return findings
    .filter((f) => isReportable(f))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, Math.max(0, limit));
}
