/**
 * Перевод реплики журнала общения A2A на русский (слово владельца 13.11:
 * «нужно кнопку в журнал добавить перевести, много китайцев подключилось»).
 *
 * Кнопка на /hub/admin/a2a зовёт POST /api/admin/a2a/dialogs/translate с
 * номером строки. Переводится то, что лежит в строке (текст после redactPII,
 * lib/a2a/dialog-log), а не то, что прислал браузер: дверь не становится
 * переводчиком произвольного текста.
 *
 * У каждого из двух полей — вопроса и ответа — свой исход (§4.0):
 *   translated — переведено сейчас и записано;
 *   stored     — перевод уже лежал в строке, модель не звалась;
 *   not_needed — поле по-русски, переводить нечего;
 *   failed     — не смог, с причиной (модель не ответила, сверка отвергла,
 *                запись не прошла). Ничего не записано, следующее нажатие
 *                попробует снова.
 *
 * Перевод пишется в ту же строку (миграция 1437): живёт и удаляется вместе с
 * исходником. Пишется только пустое поле — параллельное нажатие второго
 * администратора чужой перевод не затирает.
 *
 * Сторожа: tests/unit/a2a-dialog-translate.test.tsx; на настоящей базе —
 * tests/integration/admin-day-counts.pg.test.ts («перевод реплик журнала A2A»).
 */

import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { TRANSLATE_MODEL_PATH, translateToRussian, type TranslationOutcome } from '@/lib/ai/translate-text';

export type DialogFieldOutcome =
  | { status: 'translated' | 'stored'; text: string }
  | { status: 'not_needed' }
  | { status: 'failed'; reason: string };

export type DialogTranslateResult =
  | { found: true; id: number; question: DialogFieldOutcome; answer: DialogFieldOutcome }
  /** Строки нет: срок хранения вышел, и уборка её удалила. */
  | { found: false };

interface DialogRow {
  id: string | number;
  question: string;
  answer: string;
  question_ru: string | null;
  answer_ru: string | null;
}

type Translate = (text: string) => Promise<TranslationOutcome>;

async function fieldOutcome(source: string, stored: string | null, translate: Translate): Promise<DialogFieldOutcome> {
  if (stored && stored.trim()) return { status: 'stored', text: stored };
  const out = await translate(source);
  if (out.status === 'translated') return { status: 'translated', text: out.text };
  if (out.status === 'not_needed') return { status: 'not_needed' };
  return { status: 'failed', reason: out.reason };
}

const freshText = (o: DialogFieldOutcome): string | null => (o.status === 'translated' ? o.text : null);

/**
 * Перевести строку журнала и записать перевод. Отказ базы бросается наружу
 * (роут ответит 503 и назовёт SQLSTATE в логе); отказ модели — исход поля.
 */
export async function translateDialog(
  id: number,
  translate: Translate = translateToRussian,
): Promise<DialogTranslateResult> {
  const { rows } = await pool.query<DialogRow>(
    `SELECT id, question, answer, question_ru, answer_ru FROM a2a_dialogs WHERE id = $1::bigint`,
    [id],
  );
  const row = rows[0];
  if (!row) return { found: false };

  let [question, answer] = await Promise.all([
    fieldOutcome(row.question, row.question_ru, translate),
    fieldOutcome(row.answer, row.answer_ru, translate),
  ]);

  const q = freshText(question);
  const a = freshText(answer);
  if (q !== null || a !== null) {
    try {
      const saved = await pool.query<{ question_ru: string | null; answer_ru: string | null }>(
        `UPDATE a2a_dialogs
            SET question_ru       = COALESCE(question_ru, $2::text),
                answer_ru         = COALESCE(answer_ru, $3::text),
                translated_at     = NOW(),
                translation_model = $4::text
          WHERE id = $1::bigint
          RETURNING question_ru, answer_ru`,
        [id, q, a, TRANSLATE_MODEL_PATH],
      );
      const now = saved.rows[0];
      // Строку успела удалить уборка: записывать некуда, и на странице её уже нет.
      if (!now) return { found: false };
      // Кто-то записал раньше нас — показываем то, что лежит в строке.
      if (q !== null && now.question_ru && now.question_ru !== q) question = { status: 'stored', text: now.question_ru };
      if (a !== null && now.answer_ru && now.answer_ru !== a) answer = { status: 'stored', text: now.answer_ru };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      console.error(
        '[a2a-dialog-translate] перевод не записан:',
        typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
      );
      // Перевод, который не лёг в строку, за переведённый не выдаём: при
      // следующем открытии страницы его не будет.
      const notSaved: DialogFieldOutcome = { status: 'failed', reason: 'перевод получен, но не записан в журнал' };
      if (q !== null) question = notSaved;
      if (a !== null) answer = notSaved;
    }
  }
  return { found: true, id, question, answer };
}
