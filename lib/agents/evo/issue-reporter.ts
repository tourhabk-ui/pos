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

import { isCredibleFinding } from '@/lib/agents/evo/finding-guard';

export interface GrowthFinding {
  id: string;
  category: string;
  severity: string;
  file_path: string | null;
  line_number: number | null;
  title: string;
  description: string | null;
  suggestion: string | null;
  /**
   * Кто породил находку: реальная модель-решатель или 'deterministic'.
   * Поле есть в БД с EVO-4, но в тикет не попадало — то есть там, где владелец
   * находки ЧИТАЕТ, было не видно, сильная модель их дала или waterfall тихо
   * съехал на фоллбэк. «Аудит считает флагман» оставалось верой.
   */
  model?: string | null;
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
 *
 * Плюс страж достоверности. Инцидент 24.07: ночью рука вынесла в трекер 10
 * issues — все про один booking-роут, все ложные (7 перефразировок «нет
 * requireAuth» при живых verifyToken/extractToken, «нет try/catch» при семи
 * блоках, «нужен FOR UPDATE» при существующем FOR UPDATE). Страж защищал только
 * ВХОД (скан), а выход публиковал что угодно из БД — включая до-стражевый мусор.
 * Теперь недостоверное не выходит наружу (сверку с исходником делает
 * verifyAgainstSource на уровне раннера — там есть тело файла).
 */
export function isReportable(f: Pick<GrowthFinding, 'severity' | 'title' | 'description' | 'suggestion'> & { status?: string; github_issue_url?: string | null }): boolean {
  if (f.github_issue_url) return false;
  if (f.status && f.status !== 'suggested') return false;
  if (f.severity === 'low') return false;
  return isCredibleFinding({
    title: f.title,
    description: f.description ?? '',
    suggestion: f.suggestion ?? '',
  });
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
  const who = f.model
    ? (f.model === 'deterministic' ? 'детерминированной проверкой (без модели)' : `моделью \`${f.model}\``)
    : 'моделью (не записана — прогон до появления атрибуции)';
  lines.push(`_Заведено автоматически рукой эволюции (Evo Growth Scan). Находка \`${f.id}\`, найдена ${who}._`);
  return lines.join('\n');
}

/**
 * Категории «взгляда наружу» (разведка Scout → intel-bridge). Им держим бронь
 * в квоте: severity у них 'medium', и при сортировке critical-первыми они
 * встают в хвост. Инцидент 24.07: 10 критикалов (все ложные) съели весь
 * REPORT_LIMIT, и разведка не доехала до трекера НИ РАЗУ — петля «глаза наружу
 * → руки внутрь» была разорвана не логикой, а очередью.
 */
export const OUTWARD_CATEGORIES = new Set(['intel']);

/** Сколько слотов квоты бронируем под разведку (если такие находки есть). */
export const OUTWARD_RESERVE = 3;

/**
 * Отсортированные по severity (critical → low) и обрезанные до limit находки.
 * Из квоты до OUTWARD_RESERVE слотов резервируется под разведку — но только
 * под реально существующие intel-находки: нет разведки → всё уходит коду.
 */
export function selectReportable(findings: GrowthFinding[], limit: number): GrowthFinding[] {
  const max = Math.max(0, limit);
  if (max === 0) return [];

  const bySeverity = (a: GrowthFinding, b: GrowthFinding) => severityRank(a.severity) - severityRank(b.severity);
  const eligible = findings.filter((f) => isReportable(f));

  const outward = eligible.filter((f) => OUTWARD_CATEGORIES.has(f.category)).sort(bySeverity);
  const inward = eligible.filter((f) => !OUTWARD_CATEGORIES.has(f.category)).sort(bySeverity);

  const outwardSlots = Math.min(outward.length, OUTWARD_RESERVE, max);
  const picked = [
    ...inward.slice(0, max - outwardSlots),
    ...outward.slice(0, outwardSlots),
  ];

  // Незанятые слоты (например, кода меньше, чем места) добираем из остатка.
  if (picked.length < max) {
    const taken = new Set(picked.map((f) => f.id));
    picked.push(...eligible.filter((f) => !taken.has(f.id)).sort(bySeverity).slice(0, max - picked.length));
  }

  return picked.sort(bySeverity).slice(0, max);
}
