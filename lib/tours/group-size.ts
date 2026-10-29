/**
 * Размер группы тура словами — одно правило на все поверхности.
 *
 * Повод — слово владельца 29.10: «да, сделай «группа не ограничена» на
 * карточке». Гид Запорожец про Курильское озеро: «количество человек не
 * ограничено, но должно быть кратно 4 … можно нанять еще машины»; про
 * морскую прогулку в бухту Русскую: «до 10 человек в лодке, но по сути можно
 * набирать больше и потом устраивать их на другие лодки». А карточка читала
 * `max_participants` как группу тура и писала «Группа: до 12» — это потолок
 * одной заявки в форме платформы, а не предел гида.
 *
 * Признак `operator_tours.group_size_unlimited` (миграция 1341) говорит
 * правду о туре словами; ёмкость он НЕ меняет: потолок заявки
 * (`max_participants`, форма — не больше {@link BOOKING_FORM_MAX_PARTICIPANTS})
 * и места на датах гейт брони судит как прежде (lib/bookings/reserve.ts).
 * Поэтому при TRUE рядом со словами «не ограничена» всегда стоит, сколько
 * человек принимает ОДНА заявка на сайте, — иначе агент пообещал бы бронь на
 * двадцать человек, которую форма не примет.
 */

/** Сколько человек принимает одна заявка в форме брони (BookingFormClient). */
export const BOOKING_FORM_MAX_PARTICIPANTS = 12;

export interface GroupSizeFacts {
  max_participants?: number | string | null;
  /** operator_tours.group_size_unlimited (1341). Нет поля — как FALSE. */
  group_size_unlimited?: boolean | null;
}

function positiveInt(v: number | string | null | undefined): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Признак записан и равен TRUE. NULL/нет поля — ограничение тура не снято. */
export function isGroupSizeUnlimited(t: GroupSizeFacts): boolean {
  return t.group_size_unlimited === true;
}

/**
 * Потолок одной заявки на сайте: меньшее из числа тура и потолка формы.
 * Числа у тура нет — null (форма тогда берёт своё умолчание, а слова его не
 * называют).
 */
export function bookingRequestCeiling(maxParticipants: number | string | null | undefined): number | null {
  const max = positiveInt(maxParticipants);
  return max === null ? null : Math.min(max, BOOKING_FORM_MAX_PARTICIPANTS);
}

/** Значение для полосы фактов карточки («Группа · …»). Нечего сказать — null. */
export function groupStripValue(t: GroupSizeFacts): string | null {
  if (isGroupSizeUnlimited(t)) return 'не ограничена';
  const max = positiveInt(t.max_participants);
  return max === null ? null : `до ${max}`;
}

/**
 * Строка для агентов и текстов (MCP, Кузьмич, описание, фиды): при TRUE —
 * «Группа не ограничена (одна заявка на сайте — до N человек).», иначе —
 * «Группа до N человек.». Нет ни признака, ни числа — null.
 */
export function groupSentence(t: GroupSizeFacts): string | null {
  if (isGroupSizeUnlimited(t)) return unlimitedGroupSentence(t.max_participants);
  const max = positiveInt(t.max_participants);
  return max === null ? null : `Группа до ${max} человек.`;
}

/**
 * Строка тура без предела группы — всегда есть: «Группа не ограничена (одна
 * заявка на сайте — до N человек).», без числа — «Группа не ограничена.».
 * Для мест, которые уже знают, что признак TRUE (карточка, SDK-инструменты).
 */
export function unlimitedGroupSentence(maxParticipants: number | string | null | undefined): string {
  const ceiling = bookingRequestCeiling(maxParticipants);
  return ceiling === null
    ? 'Группа не ограничена.'
    : `Группа не ограничена (одна заявка на сайте — до ${ceiling} человек).`;
}

/**
 * Строка группы только для тура БЕЗ предела, иначе null. Для поверхностей,
 * которые до 1341 о группе молчали (get_tour_details Кузьмича, MCP fetch
 * tour:): `max_participants` у части туров — не слово оператора, а заглушка
 * (1176: «технический потолок набора 15 … уточнить у оператора»; 955:
 * «Единица неверна»), и «Группа до 15 человек.» ушла бы агенту фактом о туре
 * (§4.0). Признак TRUE же — слово гида, записанное владельцем.
 */
export function groupSentenceIfUnlimited(t: GroupSizeFacts): string | null {
  return isGroupSizeUnlimited(t) ? unlimitedGroupSentence(t.max_participants) : null;
}

/**
 * Диапазон группы для плашки с иконкой людей (блок «Туры по маршруту»):
 * «1–12», «до 12» или «не ограничена». Нечего сказать — null.
 */
export function groupRangeShort(t: GroupSizeFacts & { min_participants?: number | string | null }): string | null {
  if (isGroupSizeUnlimited(t)) return 'не ограничена';
  const max = positiveInt(t.max_participants);
  const min = positiveInt(t.min_participants);
  if (min !== null && max !== null) return `${min}–${max}`;
  return max === null ? null : `до ${max}`;
}

/** Коротко для плашек фактов («до 12 чел.» / «группа не ограничена»). */
export function groupShort(t: GroupSizeFacts): string | null {
  if (isGroupSizeUnlimited(t)) return 'группа не ограничена';
  const max = positiveInt(t.max_participants);
  return max === null ? null : `до ${max} чел.`;
}
