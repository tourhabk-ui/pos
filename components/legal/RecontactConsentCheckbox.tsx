'use client';

import {
  RECONTACT_CONSENT_TEXT,
  RECONTACT_POLICY_LINK,
  RECONTACT_POLICY_URL,
  type RecontactLang,
} from '@/lib/legal/recontact-consent';

/**
 * Отдельная галочка согласия на повторный контакт (одно напоминание о
 * неотправленной заявке). По умолчанию НЕ стоит; не заменяет PdConsentCheckbox
 * и не блокирует отправку заявки. Снять — значит отозвать согласие.
 * Вид и ссылка на политику — как у основной галочки.
 */
export function RecontactConsentCheckbox({
  checked,
  onChange,
  id = 'recontact-consent',
  lang = 'ru',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
  lang?: RecontactLang;
}) {
  const link = RECONTACT_POLICY_LINK[lang];
  return (
    <label htmlFor={id} className="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-xs leading-relaxed text-[var(--text-secondary)]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-5 h-5 shrink-0 accent-[var(--accent)]"
      />
      <span>
        {RECONTACT_CONSENT_TEXT[lang]} {link.before}{lang === 'zh' ? '' : ' '}
        <a href={RECONTACT_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">
          {link.link}
        </a>
        {link.end}
      </span>
    </label>
  );
}
