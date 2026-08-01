/**
 * Чтение выученного — недостающая половина петли знаний.
 *
 * До 31.07 обучение эволюции было write-only: feedback-loop извлекал из
 * вердиктов человека «уроки» (`evo_feedback.ai_learning`) и вёл сводную
 * стратегию (`evo_agent_state.learning_summary`) — и НИ ОДИН модуль это не
 * читал. Grep по репозиторию давал ноль потребителей: система вела дневник,
 * который никто не открывал, а сканер каждый прогон начинал с чистого листа.
 *
 * Этот модуль собирает выученное в один компактный блок для промпта ревью:
 *
 *   1. стратегия — накопленная сводка уроков (learning_summary);
 *   2. свежие уроки — последние ai_learning из evo_feedback;
 *   3. детерминированная сводка отказов — «файл :: класс претензии ×N» из
 *      rejected/ignored находок. Это не текст модели, а агрегат вердиктов:
 *      даже если LLM-уроки пусты, сканер видит, где он уже ошибался.
 *
 * Философия §8 (CLAUDE.md) соблюдена: в ШАБЛОН промпта не добавляется ни
 *  одного кейса — блок собирается из ДАННЫХ на каждом прогоне и сам сжимается
 * (лимиты строк и символов). Разрастающийся список исключений в шаблоне —
 * признак нужды в инструменте; этот модуль и есть инструмент.
 *
 * Чистые функции отделены от БД — под тестом.
 */

import { pool } from '@/lib/db-pool';
import { claimSignature, type SignatureInput } from '@/lib/agents/evo/claim-signature';
import { guardMemoryText } from '@/lib/agents/evo/memory-guard';

export interface LearnedLessons {
  /** Накопленная сводка уроков (evo_agent_state.learning_summary). */
  strategy: string | null;
  /** Свежие уроки из вердиктов (evo_feedback.ai_learning), новые первыми. */
  lessons: string[];
  /** Детерминированная сводка отказов: «file :: класс ×N», по убыванию N. */
  rejectedDigest: string[];
}

/** Максимум строк в каждой части — блок обязан оставаться компактным. */
export const MAX_LESSONS = 8;
export const MAX_REJECTED_LINES = 10;
/** Потолок всего блока в символах: промпт ревью не резиновый. */
export const MAX_BLOCK_CHARS = 1800;

/**
 * Сводка отказов из строк rejected/ignored находок. Чистая функция:
 * группирует по сигнатуре претензии (класс, не формулировка) и отдаёт
 * строки «file :: класс ×N» по убыванию частоты.
 */
export function buildRejectedDigest(
  rows: Array<SignatureInput>,
  maxLines = MAX_REJECTED_LINES,
): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const sig = claimSignature(r);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, maxLines))
    .map(([sig, n]) => (n > 1 ? `${sig} ×${n}` : sig));
}

/**
 * Блок для промпта. Пустое выученное → пустая строка (в промпт ничего не
 * добавляется — не занимаем контекст заглушками). Чистая функция.
 */
export function lessonsPromptBlock(l: LearnedLessons, maxChars = MAX_BLOCK_CHARS): string {
  const parts: string[] = [];

  if (l.strategy && l.strategy.trim()) {
    parts.push(`Накопленная стратегия (из вердиктов человека):\n${l.strategy.trim()}`);
  }
  if (l.lessons.length > 0) {
    parts.push('Свежие уроки:\n' + l.lessons.slice(0, MAX_LESSONS).map((s) => `• ${s}`).join('\n'));
  }
  if (l.rejectedDigest.length > 0) {
    parts.push(
      'Уже отвергнуто человеком (класс претензии по файлу — НЕ повторять эти претензии):\n' +
      l.rejectedDigest.map((s) => `• ${s}`).join('\n'),
    );
  }

  if (parts.length === 0) return '';

  const block = `\n\nВЫУЧЕНО НА ПРОШЛЫХ ВЕРДИКТАХ (данные, не мнение — учитывай):\n${parts.join('\n\n')}`;
  return block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
}

/**
 * Загрузка выученного из БД. Каждая часть падает независимо и молча: петля
 * знаний — усилитель качества, а не условие работы сканера. Нет данных или
 * нет таблицы → пустые части → lessonsPromptBlock вернёт ''.
 */
export async function loadLearnedLessons(): Promise<LearnedLessons> {
  const [strategyRows, lessonRows, rejectedRows] = await Promise.all([
    pool.query<{ value: unknown }>(
      `SELECT value FROM evo_agent_state WHERE key = 'learning_summary'`,
    ).then((r) => r.rows).catch(() => []),
    pool.query<{ ai_learning: string }>(
      `SELECT ai_learning FROM evo_feedback
        WHERE ai_learning IS NOT NULL AND ai_learning <> ''
        ORDER BY created_at DESC
        LIMIT ${MAX_LESSONS}`,
    ).then((r) => r.rows).catch(() => []),
    pool.query<{ file_path: string | null; title: string | null; description: string | null; suggestion: string | null }>(
      `SELECT file_path, title, description, suggestion
         FROM evo_growth_issues
        WHERE status IN ('rejected', 'ignored')
        ORDER BY resolved_at DESC NULLS LAST
        LIMIT 100`,
    ).then((r) => r.rows).catch(() => []),
  ]);

  // Страж памяти (memory-guard, ASI06): всё, что поедет в промпт решателя,
  // проходит детерминированную проверку. Урок с императивом перехвата,
  // URL или секретом — не урок, а чужой текст: отбрасывается целиком.
  // Стратегия длиннее урока — ей потолок блока, не фрагмента.
  const rawStrategy = strategyRows[0]?.value;
  const strategy = guardMemoryText(rawStrategy, MAX_BLOCK_CHARS);

  return {
    strategy,
    lessons: lessonRows
      .map((r) => guardMemoryText(r.ai_learning))
      .filter((s): s is string => s !== null),
    rejectedDigest: buildRejectedDigest(rejectedRows),
  };
}
