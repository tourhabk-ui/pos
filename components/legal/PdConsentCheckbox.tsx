'use client';

import {
  PD_CONSENT_TEXT,
  PD_CONSENT_POLICY_URL,
} from '@/lib/legal/pd-consent';

/**
 * Галочка согласия на обработку ПД — одна на всю платформу.
 *
 * Замер 23.08: из девяти форм, отправляющих имя и телефон, галочка стояла на
 * двух, на трёх была строка «нажимая кнопку, вы соглашаетесь», а на четырёх не
 * было ничего. При этом ни одна из галочек до сервера не доходила — согласие
 * жило в браузере и умирало вместе с вкладкой.
 *
 * Компонент один, чтобы формулировка не разошлась по формам: текст берётся из
 * lib/legal/pd-consent, и он же записывается версией рядом с согласием.
 * Отправка без галочки невозможна на обеих сторонах: кнопка отключена здесь,
 * а Zod на /api/leads требует ровно `true`.
 */
export function PdConsentCheckbox({
  checked,
  onChange,
  id = 'pd-consent',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer text-xs text-[var(--text-muted)]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--accent)]"
      />
      <span>
        {PD_CONSENT_TEXT} и{' '}
        <a
          href={PD_CONSENT_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--ocean)] hover:underline"
        >
          политикой конфиденциальности
        </a>
      </span>
    </label>
  );
}
