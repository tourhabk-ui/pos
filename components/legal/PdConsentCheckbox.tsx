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
 *
 * Сам компонент отправку НЕ блокирует — он только показывает галочку и отдаёт
 * её состояние. Гейт держит форма-владелец, и законных способов два:
 *
 *  1. `disabled` у кнопки отправки по состоянию галочки (`!pdConsent`);
 *  2. проверка в обработчике submit: без галочки запрос не уходит, а человек
 *     видит, чего не хватает.
 *
 * Надёжнее оба сразу (так сделана форма брони тура): гейт на одном `disabled`
 * переживает ровно до первой правки вёрстки. Любой из двух годится, если
 * в тело запроса уходит СОСТОЯНИЕ галочки, а сервер проверяет пришедшее
 * (Zod на /api/leads требует ровно `true`). Какая форма чем держит гейт —
 * tests/unit/pd-consent-registry.test.ts и lead-pd-consent.test.ts.
 *
 * Вид (аудит 24.09): текст — --text-secondary, а не --text-muted (тот для
 * плейсхолдеров; 1.84:1 в тёмной теме — текст, от которого зависит кнопка,
 * не читался). Метка — зона нажатия не меньше 44px, галочка 20px.
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
    <label htmlFor={id} className="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-xs leading-relaxed text-[var(--text-secondary)]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-5 h-5 shrink-0 accent-[var(--accent)]"
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
