/**
 * Описание места написала модель — и это видно из журнала, а не из догадки
 * по тексту (15.10, §0 «честность»).
 *
 * Журнал происхождения (description_provenance, 911) пишут все писатели
 * описаний моделью: Editor на проде и на раннере, enrich-places,
 * enrich-routes (с 15.10). Решение владельца пишется туда же своим именем
 * (owner-decision). Текст после записи мог переписать кто угодно — миграция,
 * человек в админке, — а журнал хранит не текст, а его длину. Отсюда правило:
 *
 *   последняя запись журнала — писатель-модель
 *   И её длина совпадает с длиной описания сейчас → «написала модель».
 *
 * Иначе — молчим: не знаем, кто писал, и это не повод подписать модель.
 * Ошибка в эту сторону стоит пропущенной подписи; в другую — чужого текста,
 * названного машинным.
 */

/** Писатели описаний моделью — имена, которыми они подписываются в журнале. */
export const MODEL_DESCRIPTION_WRITERS = ['editor-ai', 'enrich-places-ai', 'enrich-routes-ai'] as const;
/** Раннер Editor подписывается с именем модели: `editor-ai-runner:<модель>`. */
export const MODEL_DESCRIPTION_WRITER_PREFIX = 'editor-ai-runner:';

export function isModelDescriptionWriter(writtenBy: string | null | undefined): boolean {
  if (!writtenBy) return false;
  return (MODEL_DESCRIPTION_WRITERS as readonly string[]).includes(writtenBy)
    || writtenBy.startsWith(MODEL_DESCRIPTION_WRITER_PREFIX);
}

export interface LastDescriptionWrite { by: string | null; chars: number | null }

export function descriptionWrittenByModel(last: LastDescriptionWrite | null, currentChars: number | null): boolean {
  if (!last || currentChars == null || last.chars == null) return false;
  return isModelDescriptionWriter(last.by) && last.chars === currentChars;
}

/**
 * То же правило на SQL — для очередей, которые выбирают записи в базе
 * (Editor, 23.10: переписывать короткое описание он вправе, только если это
 * его собственный текст). Последняя запись журнала по сущности — писатель-
 * модель И её длина совпадает с длиной описания сейчас. Писатели — из тех же
 * констант, что у `isModelDescriptionWriter`: два списка разошлись бы.
 *
 * `entityIdExpr` и `descriptionExpr` — выражения кода (`ark.id`,
 * `ark.description`), не ввод.
 */
export function descriptionWrittenByModelSql(entityIdExpr: string, descriptionExpr: string): string {
  const writers = MODEL_DESCRIPTION_WRITERS.map((w) => `'${w}'`).join(', ');
  return `EXISTS (
         SELECT 1 FROM (
           SELECT dp_last.written_by, dp_last.chars
             FROM description_provenance dp_last
            WHERE dp_last.entity_id = ${entityIdExpr}
            ORDER BY dp_last.written_at DESC, dp_last.id DESC
            LIMIT 1) last_write
          WHERE (last_write.written_by IN (${writers})
                 OR last_write.written_by LIKE '${MODEL_DESCRIPTION_WRITER_PREFIX}%')
            AND last_write.chars = LENGTH(${descriptionExpr}))`;
}
