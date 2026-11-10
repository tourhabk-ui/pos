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
  /**
   * Кто руководитель: гид оператора (по умолчанию — кабинет оператора) или
   * сам турист самостоятельной группы (/register). Назвать туриста «гидом» в
   * заявке МЧС — неправда о группе.
   */
  leaderRole?: 'guide' | 'self';
  emergencyContacts: ReadonlyArray<{ name: string; phone: string; relation?: string }>;
}

/** «2026-10-12» или ISO → «12.10.2026»; непонятное — как есть. */
function ruDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value.trim();
}

const clean = (s: string | undefined) => (s ?? '').trim();

/**
 * Чего в записи кабинета нет, а памятка ГУ МЧС по краю просит указать в
 * маршрутном листе. Не «форма спрашивает»: онлайн-форму отсюда не проверить.
 */
export const MCHS_NOT_IN_RECORD: readonly string[] = [
  'страна проживания и адреса участников',
  'координаты контрольных точек маршрута',
  'время и способ сеансов связи (спутниковый телефон, рация, график)',
  'средства первой помощи и страховочное снаряжение',
  'средства передвижения',
  'места ночлега по дням',
  'согласия всех участников на обработку персональных данных',
];

/** Сколько контактных лиц вне похода просит памятка ГУ МЧС по краю. */
export const MCHS_CONTACTS_NEEDED = 2;

export function mchsFormText(r: MchsFormInput): string {
  const out: string[] = ['Регистрация туристской группы — Камчатский край', ''];

  out.push(`Даты: ${ruDate(r.startDate)} — ${ruDate(r.endDate)}`);
  out.push(`Маршрут: ${clean(r.route) || 'не указан'}`);
  out.push('');

  out.push(r.guideContacts
    ? `Руководитель группы${r.leaderRole === 'self' ? '' : ' (гид)'}: ${clean(r.guideContacts.name)}, тел. ${clean(r.guideContacts.phone)}`
    : 'Руководитель группы: не указан');
  out.push('');

  out.push(`Участники (${r.groupComposition.length}):`);
  r.groupComposition.forEach((m, i) => {
    const bits = [clean(m.fullName)];
    // Форма /register спрашивает только год — и называть его «датой» нельзя.
    const born = clean(m.birthDate);
    if (/^\d{4}$/.test(born)) bits.push(`год рождения ${born}`);
    else if (born) bits.push(`дата рождения ${ruDate(born)}`);
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
  if (r.emergencyContacts.length < MCHS_CONTACTS_NEEDED) {
    out.push(`— ГУ МЧС по краю просит ${MCHS_CONTACTS_NEEDED} контактных лица, которые не идут в поход: допишите в заявке`);
  }
  out.push('');

  out.push(`В записи Ведара этого нет, а ГУ МЧС по краю просит указать в маршрутном листе: ${MCHS_NOT_IN_RECORD.join('; ')}.`);
  out.push(`Подать заявку нужно не позднее чем за ${MCHS_LEAD_WORKING_DAYS} рабочих дней до начала маршрута.`);
  return out.join('\n');
}
