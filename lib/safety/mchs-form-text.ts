/**
 * Текст регистрации группы для формы МЧС — из записи кабинета оператора.
 *
 * Решение владельца 30.09 («по мчс 2»): Ведар не отправляет данные в МЧС сам,
 * а готовит их одним текстом, который оператор переносит в официальную форму
 * (forms.mchs.gov.ru) и отправляет от своего имени. Автоматической подачи нет
 * и не будет без отдельного решения: паспортные данные участников ушли бы в
 * чужую форму от нашего имени (152-ФЗ), а форма такой отправки не предполагает.
 *
 * Что МЧС требует — MCHS_REQUIRED_DATA (lib/safety/mchs-registration.ts).
 * Адреса участников, сеансов связи и транспорта в записи кабинета нет: текст
 * называет их вслух как «заполните в форме», а не молчит — иначе оператор
 * решит, что скопировал всё (§4.0). Порядок полей самой формы МЧС отсюда не
 * проверить (сайт недоступен из среды разработки), поэтому текст сгруппирован
 * по смыслу, а не выдаётся за «поля формы по порядку».
 */
import { MCHS_LEAD_WORKING_DAYS } from '@/lib/safety/mchs-registration';

export interface MchsFormInput {
  route: string;
  startDate: string;
  endDate: string;
  groupComposition: ReadonlyArray<{ fullName: string; phone?: string; birthDate?: string }>;
  guideContacts: { name: string; phone: string } | null;
  emergencyContacts: ReadonlyArray<{ name: string; phone: string; relation?: string }>;
}

/** «2026-10-12» или ISO → «12.10.2026»; непонятное — как есть. */
function ruDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value.trim();
}

const clean = (s: string | undefined) => (s ?? '').trim();

/** Чего в записи кабинета нет, но форма МЧС спрашивает. */
export const MCHS_NOT_IN_RECORD: readonly string[] = [
  'адреса участников',
  'время и способ сеансов связи (спутниковый телефон, рация, график)',
  'средства передвижения',
  'места ночлега по дням',
];

export function mchsFormText(r: MchsFormInput): string {
  const out: string[] = ['Регистрация туристской группы — Камчатский край', ''];

  out.push(`Даты: ${ruDate(r.startDate)} — ${ruDate(r.endDate)}`);
  out.push(`Маршрут: ${clean(r.route) || 'не указан'}`);
  out.push('');

  out.push(r.guideContacts
    ? `Руководитель группы (гид): ${clean(r.guideContacts.name)}, тел. ${clean(r.guideContacts.phone)}`
    : 'Руководитель группы: не указан');
  out.push('');

  out.push(`Участники (${r.groupComposition.length}):`);
  r.groupComposition.forEach((m, i) => {
    const bits = [clean(m.fullName)];
    if (clean(m.birthDate)) bits.push(`дата рождения ${ruDate(clean(m.birthDate))}`);
    if (clean(m.phone)) bits.push(`тел. ${clean(m.phone)}`);
    out.push(`${i + 1}. ${bits.join(', ')}`);
  });
  out.push('');

  out.push('Контакты для экстренной связи:');
  if (r.emergencyContacts.length === 0) out.push('— не указаны');
  for (const c of r.emergencyContacts) {
    const rel = clean(c.relation) ? ` (${clean(c.relation)})` : '';
    out.push(`— ${clean(c.name)}${rel}, тел. ${clean(c.phone)}`);
  }
  out.push('');

  out.push(`В записи Ведара этого нет — заполните в форме МЧС: ${MCHS_NOT_IN_RECORD.join('; ')}.`);
  out.push(`Подать заявку нужно не позднее чем за ${MCHS_LEAD_WORKING_DAYS} рабочих дней до начала маршрута.`);
  return out.join('\n');
}
