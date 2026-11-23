/**
 * Почему тур не ставится на дату плана (PDF владельца 23.11).
 *
 * Факты — только из записи: минимум возраста занятия, фраза «от N лет» /
 * «с N лет» в коротком описании и составе, окно открытия места
 * (`location_safety_profile.open_from_date` / `open_to_date`), закрытие
 * парка из сводки. Чего в записи нет — тур этим правилом не блокируется.
 *
 * Сезон `operator_tours.season_start/end` сюда не входит: его уже судит
 * `tourFitsDate` (тур без календаря вне записанного сезона в план не
 * встаёт). Правило 08.10 остаётся: нет календаря, нет окна места и нет
 * закрытия парка — месяц открыт, дату подтвердит оператор.
 *
 * Возраст действует и на тур с календарём: выезд не отменяет «от 12 лет».
 * Закрытие парка и окно места — только у тура без календаря: подтверждённый
 * выезд оператора остаётся, а на дне стоит предупреждение сводки.
 */
export type TourGateReason = 'park_and_off_season' | 'park' | 'place' | 'age';

export interface TourGateInput {
  /** `request` — календаря нет. Остальное этим модулем по сезону не режется. */
  kind: 'request' | 'dated' | 'unread' | undefined;
  youngest: number | null;
  activityMinAge: number;
  activityName: string;
  placeOpenFrom: string | null;
  placeOpenTo: string | null;
  /** Дата дня вне месяцев занятия (`ACTIVITY_CONSTRAINTS.months`). */
  offOrientation: boolean;
  parkClosed: boolean;
  /** Короткое описание и состав тура — оттуда читается «от N лет». */
  ageText: string;
  /** Дата дня, YYYY-MM-DD. Для возраста не нужна. */
  date: string;
}

export interface TourGate {
  reason: TourGateReason;
  /** Хвост строки «Не ставили: «тур» — …». У совмещённого закрытия пусто: текст собирает движок, как раньше. */
  clause: string;
}

const AGE_RE = /(?:^|[^\d])(?:от|с)\s+(\d{1,2})\s+лет/gi;

/** Самый высокий «от N лет» в тексте оператора. Нет фразы — null, возраст не выдумывается. */
export function recordedMinAge(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(AGE_RE)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 17 && (best === null || n > best)) best = n;
  }
  return best;
}

/** Дата вне записанного окна. Окна нет — false: неизвестное не закрыто. */
export function dateOutsideRecordedWindow(date: string, start: string | null, end: string | null): boolean {
  const s = start && /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : null;
  const e = end && /^\d{4}-\d{2}-\d{2}/.test(end) ? end.slice(0, 10) : null;
  if (!s && !e) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (s && date < s) return true;
  if (e && date > e) return true;
  return false;
}

function ru(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function windowWords(start: string | null, end: string | null): string | null {
  const a = ru(start);
  const b = ru(end);
  if (a && b) return `с ${a} по ${b}`;
  if (a) return `с ${a}`;
  if (b) return `до ${b}`;
  return null;
}

export function tourGate(input: TourGateInput): TourGate | null {
  const floor = recordedMinAge(input.ageText);
  const ageBits: string[] = [];
  if (input.youngest !== null && input.activityMinAge > 0 && input.youngest < input.activityMinAge) {
    ageBits.push(`занятие «${input.activityName}» допускает с ${input.activityMinAge} лет`);
  }
  if (input.youngest !== null && floor !== null && input.youngest < floor) {
    ageBits.push(`в тексте тура указано «от ${floor} лет»`);
  }
  if (ageBits.length > 0 && input.youngest !== null) {
    return {
      reason: 'age',
      clause: `в группе ребёнок ${input.youngest} лет, а ${ageBits.join('; ')}`,
    };
  }
  if (input.kind !== 'request') return null;
  if (dateOutsideRecordedWindow(input.date, input.placeOpenFrom, input.placeOpenTo)) {
    const w = windowWords(input.placeOpenFrom, input.placeOpenTo);
    const park = input.parkClosed ? ', на дату записано закрытие парка' : '';
    return {
      reason: 'place',
      clause: `дата вне окна, когда место открыто по карточке места${w ? ` (${w})` : ''}${park}, а подтверждённого выезда у тура нет`,
    };
  }
  if (input.parkClosed && input.offOrientation) {
    return { reason: 'park_and_off_season', clause: '' };
  }
  if (input.parkClosed) {
    return {
      reason: 'park',
      clause: 'на эту дату у места тура записано закрытие парка, а подтверждённого выезда у тура нет',
    };
  }
  return null;
}
