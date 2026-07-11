/**
 * lib/agents/eval/live-questions.ts
 *
 * Живая выборка вопросов туристов для faithfulness-регрессии Кузьмича.
 *
 * Мотивация (интерпретируемостное исследование Anthropic, J-Lens, июль 2026):
 * модели различают «тестовый» и «живой» контекст — фиксированные фикстурные
 * вопросы могут систематически получать более аккуратные ответы, чем реальный
 * трафик. Регрессия на сэмпле настоящих вопросов из chat_sessions измеряет
 * тот конвейер, который видит турист, а не его витринную версию.
 *
 * PII: телефоны, email и telegram-хэндлы маскируются ДО того, как вопрос
 * попадёт в eval-отчёт, лог агента или промпт судьи.
 */

import { query } from '@/lib/database';
import type { EvalQuestion } from '@/lib/agents/eval/kuzmich-faithfulness';

// ── Чистые функции (юнит-тестируемые, без БД) ────────────────────────────────

const PHONE_RE = /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const TG_HANDLE_RE = /@[a-z0-9_]{4,32}\b/gi;

/** Маскирует телефоны/email/telegram-хэндлы. Имена не трогаем — ложные
 *  срабатывания на топонимах («меня зовут в горы») хуже, чем имя в вопросе. */
export function maskPII(text: string): string {
  return text
    .replace(PHONE_RE, '[телефон]')
    .replace(EMAIL_RE, '[email]')
    .replace(TG_HANDLE_RE, '[контакт]');
}

/** Годится ли сообщение как eval-вопрос: не команда, не приветствие,
 *  осмысленной длины, содержит кириллицу или латиницу. */
export function isEvalWorthy(text: string): boolean {
  const t = text.trim();
  if (t.length < 12 || t.length > 300) return false;
  if (t.startsWith('/')) return false;
  if (!/[а-яёa-z]/i.test(t)) return false;
  // Чистые приветствия/подтверждения — шум, не вопросы
  if (/^(привет|здравствуй(те)?|добрый (день|вечер)|спасибо|да|нет|ок|окей)[!.\s]*$/i.test(t)) return false;
  return true;
}

/** Дедуп + маскинг + нарезка в EvalQuestion. Экспортирован для тестов. */
export function toEvalQuestions(rawContents: string[], limit: number): EvalQuestion[] {
  const seen = new Set<string>();
  const out: EvalQuestion[] = [];
  for (const raw of rawContents) {
    if (out.length >= limit) break;
    if (typeof raw !== 'string') continue;
    const masked = maskPII(raw.trim());
    if (!isEvalWorthy(masked)) continue;
    const key = masked.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `live-${out.length + 1}`, category: 'live', question: masked });
  }
  return out;
}

// ── Выборка из БД ─────────────────────────────────────────────────────────────

/**
 * Случайные пользовательские сообщения из веб-чатов за последние 7 дней.
 * Берём с запасом (x4) — фильтр и дедуп срежут команды, приветствия и повторы.
 */
export async function sampleLiveQuestions(limit: number): Promise<EvalQuestion[]> {
  const { rows } = await query<{ content: string }>(
    `SELECT msg->>'content' AS content
     FROM chat_sessions cs,
          jsonb_array_elements(cs.messages) AS msg
     WHERE cs.updated_at > NOW() - INTERVAL '7 days'
       AND msg->>'role' = 'user'
       AND length(msg->>'content') BETWEEN 12 AND 300
     ORDER BY random()
     LIMIT $1`,
    [limit * 4],
  );
  return toEvalQuestions(rows.map((r) => r.content), limit);
}
