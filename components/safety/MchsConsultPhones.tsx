/**
 * Телефоны для вопросов по заявке — на экране после включения контроля.
 *
 * Только из реестра проверенных номеров (lib/safety/emergency-numbers через
 * MCHS_PHONES): региональный номер попадает на экран после сверки владельца.
 * До 10.11 здесь стояли два номера литералами, и второй («ПСО КГКУ ЦОД»,
 * 41-03-95) в реестре не значится — в базе контактов он помечен непроверенным.
 * Показывать несверенный номер опаснее, чем не показывать: человек дозвонится
 * не туда (шапка реестра).
 *
 * Справочная линия — не экстренная, поэтому здесь только род `reference`;
 * дежурные номера и 112 живут на экранах беды, а не подготовки.
 */

import { telHref } from '@/lib/safety/emergency-numbers';
import { MCHS_PHONES, MCHS_RETURN_PHONE_UNKNOWN } from '@/lib/safety/mchs-registration';

export default function MchsConsultPhones() {
  const reference = MCHS_PHONES.filter((p) => p.kind === 'reference');
  if (reference.length === 0) return null;
  return (
    <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
      <p className="font-semibold text-sm mb-1">Вопросы по заявке — по телефону</p>
      {reference.map((p) => (
        <p key={p.phone} className="text-xs text-[var(--text-muted)] mt-1.5 first:mt-0">
          <a href={telHref(p.phone)} className="text-[var(--accent)] hover:underline">{p.phone}</a> — {p.purpose}
        </p>
      ))}
      <p className="text-xs text-[var(--text-muted)] mt-2">{MCHS_RETURN_PHONE_UNKNOWN}</p>
    </div>
  );
}
