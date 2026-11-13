'use client';

/**
 * Машинный перевод сообщения переписки заявки — под исходником, в админке
 * (слово владельца 13.11: «для оператора переводить на русский, а ответ
 * оператора должен быть наоборот на языке обратившегося»; миграция 1440).
 *
 * Перевод сделан один раз, при отправке сообщения, и лежит в той же строке:
 * здесь он только показывается. У слов клиента это перевод на русский — им
 * читал адресат. У слов адресата — перевод на язык клиента: его получил
 * клиент, и администратор видит, что именно ему ушло.
 *
 * Перевода нет — строки нет: «не был нужен» и «модель не справилась» в базе
 * не различаются (NULL), и выдумывать причину здесь нельзя (§4.0).
 * Текст — слова людей, под `Sensitive`, как и исходник.
 */
import { Sensitive } from '@/components/admin/shared/Sensitive';

/**
 * Подпись перевода. `to` — как на этом экране назван тот, кто обратился:
 * «Клиенту» в карточке лида, «Гостю» в заявках на жильё.
 */
export function adminTranslationLabel(author: 'owner' | 'guest', to: 'Клиенту' | 'Гостю' = 'Клиенту'): string {
  return author === 'guest' ? 'Перевод (машинный)' : `${to} ушёл перевод (машинный)`;
}

export function MessageTranslation(
  { author, translation, to }: { author: 'owner' | 'guest'; translation?: string | null; to?: 'Клиенту' | 'Гостю' },
) {
  if (typeof translation !== 'string' || !translation.trim()) return null;
  return (
    <p className="mt-0.5 text-xs text-[var(--text-secondary)] whitespace-pre-line">
      {adminTranslationLabel(author, to)}: <Sensitive>{translation}</Sensitive>
    </p>
  );
}
