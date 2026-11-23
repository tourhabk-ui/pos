'use client';

import { OFFER_ACCEPT_TEXT, OFFER_URL } from '@/lib/legal/offer';

/**
 * Отметка «принимаю оферту» на регистрации партнёра (план готовности 23.11,
 * этап 5).
 *
 * Оферта (п. 2) называет отметку о согласии частью акцепта, а на формах её
 * не было. Компонент — управляемая галочка: в тело запроса уходит её
 * СОСТОЯНИЕ (`offer_accepted`), а сервер проверяет пришедшее и пишет акцепт
 * в журнал с версией оферты. Текста оферты здесь нет — только ссылка на неё.
 *
 * Вид — как у галочки согласия на обработку данных: зона нажатия не меньше
 * 44px, текст `--text-secondary`.
 */
export function OfferAcceptCheckbox({
  checked,
  onChange,
  id = 'offer-accept',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-xs leading-relaxed text-[var(--text-secondary)]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-5 h-5 shrink-0 accent-[var(--accent)]"
      />
      <span>
        {OFFER_ACCEPT_TEXT.before}
        <a href={OFFER_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">
          {OFFER_ACCEPT_TEXT.link}
        </a>
        {OFFER_ACCEPT_TEXT.after}
      </span>
    </label>
  );
}
