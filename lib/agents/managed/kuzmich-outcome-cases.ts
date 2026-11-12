/**
 * Плохие оценки Кузьмича — случаем, для глаз администратора (#3179, 10.11).
 *
 * Еженедельный свод (`/api/cron/kuzmich-bad-outcomes`, issue в публичном
 * репозитории) называет только числа и id: вопрос туриста и ответ Кузьмича
 * туда не выводятся. Из-за этого сами случаи не видел никто. Владелец 10.11:
 * «3179 да и нужно решение» — экран в админке, где случай можно открыть.
 *
 * Модуль лежит рядом с грейдером, а не в lib/kuzmich, намеренно: оценки —
 * род знания из разговоров с людьми, и на путях Кузьмича и MCP их читать
 * нельзя (сторож tests/unit/kuzmich-knowledge-scope.test.ts). Здесь их
 * читает только администратор.
 *
 * Здесь — чистый разбор записи грейдера (lib/agents/managed/kuzmich-outcomes):
 * «Вопрос: …\nОтвет: …\n\nОценка N/10. Проблемы: …». Телефоны и почта сняты
 * ещё при записи; при чтении они снимаются второй раз — записи старше правки
 * 15.10 могли лечь без чистки.
 */
import { CLUSTERS, issueText } from '@/lib/kuzmich/bad-outcome-clusters';
import { redactPII } from '@/lib/security/pii-redact';

/** Плохое — то же правило, что у свода: балл ниже 7, незаземлённый ответ или отказ модели. */
export const BAD_OUTCOME_CASES_SQL = `
  SELECT id, created_at, compiled_truth,
         metadata->>'surface'      AS surface,
         metadata->>'provider'     AS provider,
         metadata->>'answer_path'  AS answer_path,
         metadata->>'outcome_kind' AS outcome_kind,
         metadata->'tools_ran'     AS tools_ran,
         NULLIF(substring(title from 'Оценка ответа: ([0-9]+)/10'), '')::int AS score
    FROM agent_knowledge
   WHERE type = 'outcome' AND agent_id = 'kuzmich'
     AND created_at > NOW() - ($1::int * INTERVAL '1 day')
     AND (compiled_truth ~ 'Оценка [0-6]/10'
          OR compiled_truth LIKE '%НЕЗАЗЕМЛЁННЫЕ ФАКТЫ%'
          OR metadata->>'outcome_kind' = 'refusal')
   ORDER BY created_at DESC
   LIMIT $2::int`;

/** Окно в днях: 1–90, по умолчанию 7, как у свода. */
export function parseDays(raw: string | null): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
}

/** Сколько случаев отдаёт экран за раз. Остаток называется числом, не теряется молча. */
export const CASES_LIMIT = 200;

export interface OutcomeCaseRow {
  id: number | string;
  created_at: string | Date;
  compiled_truth: string;
  surface: string | null;
  provider: string | null;
  answer_path: string | null;
  outcome_kind: string | null;
  tools_ran: unknown;
  score: number | null;
}

export interface OutcomeCase {
  id: number;
  created_at: string;
  /** Балл судьи; у отказа модели балла нет — null. */
  score: number | null;
  refusal: boolean;
  surface: string | null;
  provider: string | null;
  answer_path: string | null;
  tools: string[];
  /** Вопрос и ответ так, как их сохранил грейдер (обрезаны до 150 и 300 знаков). */
  question: string;
  answer: string;
  /** Проблемы словами судьи, по одной. */
  issues: string[];
  /** Типы проблем — те же, что в своде. */
  clusters: { id: string; label: string }[];
}

const FIELD = /^Вопрос:\s*([\s\S]*?)\nОтвет:\s*([\s\S]*?)\n\n/;

/** Типы проблем одной записи: каждая проблема — в первый совпавший тип, без повторов. */
export function caseClusters(compiledTruth: string, outcomeKind: string | null): { id: string; label: string }[] {
  if (outcomeKind === 'refusal') return [{ id: 'refusal', label: 'Отказ модели' }];
  const issues = issueText(compiledTruth);
  if (!issues) return [{ id: 'no_issue_text', label: 'Низкий балл без текста проблем' }];
  const out: { id: string; label: string }[] = [];
  for (const part of issues.split(/;\s*/).filter(Boolean)) {
    const def = CLUSTERS.find((d) => d.re.test(part));
    const id = def?.id ?? 'other';
    if (!out.some((c) => c.id === id)) out.push({ id, label: def?.label ?? 'Прочее' });
  }
  return out;
}

/**
 * Запись грейдера → случай для экрана. Запись, у которой нет строк
 * «Вопрос:» и «Ответ:», не выбрасывается: поля пусты, а судья виден целиком —
 * так видно, что запись другой формы, а не «вопроса не было».
 */
export function parseOutcomeCase(row: OutcomeCaseRow): OutcomeCase {
  const text = String(row.compiled_truth ?? '');
  const m = FIELD.exec(text);
  const refusal = row.outcome_kind === 'refusal';
  let issues: string[];
  if (refusal) {
    const tail = text.split(/\n\n/).slice(1).join('\n\n').trim();
    issues = tail ? [tail] : [];
  } else {
    const raw = issueText(text);
    issues = raw ? raw.split(/;\s*/).map((s) => s.trim()).filter(Boolean) : [];
    if (issues.length === 0 && !m) issues = [text.trim()].filter(Boolean);
  }
  const tools = Array.isArray(row.tools_ran) ? row.tools_ran.filter((t): t is string => typeof t === 'string') : [];
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: Number(row.id),
    created_at: created,
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    refusal,
    surface: row.surface,
    provider: row.provider,
    answer_path: row.answer_path,
    tools,
    question: redactPII(m ? m[1]!.trim() : ''),
    answer: redactPII(m ? m[2]!.trim() : ''),
    issues: issues.map((s) => redactPII(s)),
    clusters: caseClusters(text, row.outcome_kind),
  };
}

const SURFACE_WORD: Record<string, string> = {
  telegram: 'Telegram', max: 'MAX', web: 'сайт', 'web-stream': 'сайт', a2a: 'агент A2A', widget: 'виджет', other: 'мессенджер',
};

/**
 * Текст случаев для разбора в сессии — то, что администратор копирует
 * кнопкой. Только поля экрана: без id чата, ключа разговора и метаданных.
 */
export function casesForReview(cases: OutcomeCase[]): string {
  return cases.map((c) => {
    const head = [
      `Случай #${c.id}`,
      c.refusal ? 'отказ модели' : `оценка ${c.score ?? '—'}/10`,
      c.surface ? SURFACE_WORD[c.surface] ?? c.surface : 'поверхность не записана',
      c.tools.length > 0 ? `инструменты: ${c.tools.join(', ')}` : 'без инструментов',
    ].join(' · ');
    return [
      head,
      `Вопрос: ${c.question || '(не сохранён)'}`,
      `Ответ: ${c.answer || '(не сохранён)'}`,
      `Судья: ${c.issues.join('; ') || '(проблем не названо)'}`,
    ].join('\n');
  }).join('\n\n');
}
