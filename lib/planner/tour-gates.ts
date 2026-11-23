/**
 * Почему тур не ставится на дату плана (PDF владельца 23.11).
 *
 * Факты — только из записи: минимум возраста занятия, фраза «от N лет» /
 * «с N лет» в коротком описании и составе, окно открытия места
 * (`location_safety_profile.open_from_date` / `open_to_date`), закрытие
 * парка из сводки и красный уровень карточки места. Чего в записи нет —
 * тур этим правилом не блокируется.
 *
 * Сезон `operator_tours.season_start/end` сюда не входит: его уже судит
 * `tourFitsDate` (тур без календаря вне записанного сезона в план не
 * встаёт). Правило 08.10 остаётся: нет календаря, нет окна места и нет
 * закрытия парка — месяц открыт, дату подтвердит оператор.
 *
 * Возраст действует и на тур с календарём: выезд не отменяет «от 12 лет».
 * Подтверждённый выезд (календарь) красное закрытие парка само по себе не
 * снимает. Если тур и так не ставится по возрасту, закрытие парка называется
 * в той же строке, а не прячется за возрастом.
 *
 * `closed = false` и пустое окно открытия не прячут красный park_closure.
 * Межсезонье без слова опасности — не красное (#3487, `isSeasonalClosure`):
 * «опасно» в сводке этот признак снимает, и закрытие остаётся красным.
 */
import { isSeasonalClosure } from '@/lib/safety/park-closure';

export type TourGateReason = 'park_and_off_season' | 'park' | 'place' | 'age';

export type PlaceCardLevel = 'red' | 'yellow' | 'green' | 'closed' | 'unknown';

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
  /** Дата дня, YYYY-MM-DD. Нет даты — закрытие парка и окно места не судятся, возраст судится. */
  date: string | null;
  /**
   * Уровень карточки места на сегодня (`placeDayStatus`). Красный при сводке
   * о закрытии парка — красный park_closure, даже если место не отмечено
   * закрытым и окно открытия пустое.
   */
  placeLevel?: PlaceCardLevel | null;
  /** Место отмечено закрытым администратором. false красный park_closure не отменяет. */
  placeClosed?: boolean;
  /**
   * Сводка карточки или текст тревоги park_closure. Слово опасности снимает
   * межсезонье (`isSeasonalClosure`). Сезонный текст красным закрытием не считается.
   */
  parkSummary?: string | null;
}

export interface TourGate {
  reason: TourGateReason;
  /** Хвост строки «Не ставили: «тур» — …». У совмещённого закрытия пусто: текст собирает движок, как раньше. */
  clause: string;
}

const AGE_RE = /(?:^|[^\d])(?:от|с)\s+(\d{1,2})\s+лет/gi;

/**
 * Самый высокий «от N лет» в тексте оператора. Нет фразы — null, возраст не
 * выдумывается. 18 и 21 — тот же записанный порог, что и детский: в группе
 * владельца есть ребёнок 17 лет, и «от 18 лет» его не пускает. Выше 21 фраза
 * в текст тура почти не пишется, а «от 30» в чужом предложении закрыло бы
 * любую семью.
 */
export function recordedMinAge(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(AGE_RE)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 21 && (best === null || n > best)) best = n;
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

/**
 * Красный park_closure с карточки места.
 *
 * `closed = false` и пустое окно не читаются как «парк открыт». Межсезонье
 * без опасности (#3487) красным не становится: сезонная сводка возвращает
 * false, даже если уровень передали красным. Слово «опасно» сезонность
 * снимает, и закрытие маршрутов при красном уровне остаётся красным.
 * Облёт чужого места этой сводкой не красится: сюда приходит карточка
 * места именно этого тура.
 */
export function redParkFromCard(input: {
  level: PlaceCardLevel | null;
  closed: boolean;
  openFrom: string | null;
  openTo: string | null;
  summary: string | null;
}): boolean {
  if (input.summary && isSeasonalClosure(input.summary)) return false;
  if (input.level !== 'red') return false;
  const text = (input.summary ?? '').toLowerCase();
  if (!/закрыт|приостанов/.test(text)) return false;
  // `closed` и окно сюда дошли и на ответ не влияют: пустое окно и
  // «не закрыто администратором» красное закрытие парка не прячут.
  void input.closed;
  void input.openFrom;
  void input.openTo;
  return true;
}

function ageClauseOf(input: TourGateInput): string | null {
  const floor = recordedMinAge(input.ageText);
  const ageBits: string[] = [];
  if (input.youngest !== null && input.activityMinAge > 0 && input.youngest < input.activityMinAge) {
    ageBits.push(`занятие «${input.activityName}» допускает с ${input.activityMinAge} лет`);
  }
  if (input.youngest !== null && floor !== null && input.youngest < floor) {
    ageBits.push(`в тексте тура указано «от ${floor} лет»`);
  }
  if (ageBits.length === 0 || input.youngest === null) return null;
  return `в группе ребёнок ${input.youngest} лет, а ${ageBits.join('; ')}`;
}

/** Красное закрытие: карточка или тревога, которая не межсезонье. */
export function parkIsRed(input: TourGateInput): boolean {
  const summary = input.parkSummary ?? null;
  const seasonal = Boolean(summary && isSeasonalClosure(summary));
  if (seasonal) return false;
  if (redParkFromCard({
    level: input.placeLevel ?? null,
    closed: input.placeClosed === true,
    openFrom: input.placeOpenFrom,
    openTo: input.placeOpenTo,
    summary,
  })) return true;
  return input.parkClosed;
}

export function tourGate(input: TourGateInput): TourGate | null {
  const ageClause = ageClauseOf(input);
  const parkRed = parkIsRed(input);

  if (input.date === null) {
    return ageClause ? { reason: 'age', clause: ageClause } : null;
  }
  // Подтверждённый выезд закрытие парка и окно места не снимают.
  // Возраст снимает, и красный парк тогда называется в той же строке.
  if (input.kind !== 'request') {
    if (!ageClause) return null;
    const extra = parkRed ? '; парк у места тура закрыт по сводке' : '';
    return { reason: 'age', clause: `${ageClause}${extra}` };
  }

  if (dateOutsideRecordedWindow(input.date, input.placeOpenFrom, input.placeOpenTo)) {
    const w = windowWords(input.placeOpenFrom, input.placeOpenTo);
    const park = parkRed || input.parkClosed ? ', на дату записано закрытие парка' : '';
    const place = `дата вне окна, когда место открыто по карточке места${w ? ` (${w})` : ''}${park}, а подтверждённого выезда у тура нет`;
    const bits = [ageClause, place].filter((x): x is string => Boolean(x));
    if (parkRed && input.offOrientation && ageClause) bits.push('по нашему сезонному ориентиру в ваши даты не сезон');
    return { reason: ageClause ? 'age' : 'place', clause: bits.join('; ') };
  }
  if (!ageClause && parkRed && input.offOrientation) {
    return { reason: 'park_and_off_season', clause: '' };
  }
  if (!ageClause && parkRed) {
    return {
      reason: 'park',
      clause: 'на эту дату у места тура записано закрытие парка, а подтверждённого выезда у тура нет',
    };
  }
  if (ageClause) {
    const bits = [ageClause];
    if (parkRed) bits.push('парк у места тура закрыт по сводке');
    if (input.offOrientation) bits.push('по нашему сезонному ориентиру в ваши даты не сезон');
    return { reason: 'age', clause: bits.join('; ') };
  }
  return null;
}
