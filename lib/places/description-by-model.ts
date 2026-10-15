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
export function isModelDescriptionWriter(writtenBy: string | null | undefined): boolean {
  if (!writtenBy) return false;
  return writtenBy === 'editor-ai'
    || writtenBy.startsWith('editor-ai-runner:')
    || writtenBy === 'enrich-places-ai'
    || writtenBy === 'enrich-routes-ai';
}

export interface LastDescriptionWrite { by: string | null; chars: number | null }

export function descriptionWrittenByModel(last: LastDescriptionWrite | null, currentChars: number | null): boolean {
  if (!last || currentChars == null || last.chars == null) return false;
  return isModelDescriptionWriter(last.by) && last.chars === currentChars;
}
