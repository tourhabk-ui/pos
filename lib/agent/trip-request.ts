/**
 * Заявка на поездку целиком: тур + жильё + машина одним вызовом (break-map
 * 01.11). Сама ничего не пишет — раскладывает поездку на части и зовёт те же
 * исполнители, что у отдельных инструментов (проверки дат, мест, согласия,
 * доставка партнёру — их). Общее: номер поездки и строка «в этой же
 * поездке …» в комментарии каждой части, чтобы оператор тура, владелец
 * жилья и менеджер с перевозчиком видели одну поездку, а не три заявки.
 *
 * Машина без перевозчика при нескольких перевозчиках — не отказ, а заявка
 * менеджеру Ведара (create_lead) с той же строкой поездки.
 */
import { randomBytes } from 'node:crypto';
import { pickHeadcount } from '@/lib/agent/headcount';
import { getPublicBaseUrl } from '@/lib/config';
import { textFailed } from '@/lib/agent/request-outcome';
import { planAttachNote, type PlanAttach } from '@/lib/leads/plan-from-draft';
import { OPERATOR_NO_CHANNEL_MARK, OPERATOR_REACH_UNKNOWN_MARK } from '@/lib/mcp/request-confirm-note';

export type LegKind = 'tour' | 'stay' | 'transfer';

export interface TripLegResult {
  kind: LegKind;
  ok: boolean;
  text: string;
}

/** Часть поездки, которую ведёт менеджер: номер поездки и что в ней. */
export interface TripManagerPart {
  tripId: string;
  parts: Array<'transfer' | 'stay'>;
}

export interface TripDeps {
  bookTour(args: Record<string, unknown>): Promise<string>;
  requestStay(args: Record<string, unknown>): Promise<string>;
  requestCharter(args: Record<string, unknown>): Promise<string>;
  /**
   * Заявка менеджеру на части без адресата. `tripPart` — что это часть
   * поездки, а не подбор тура: лид получает род `trip_manager`, и крон
   * добивки не отдаёт его постороннему туроператору (разбор 06.11).
   */
  createLead(args: Record<string, unknown>, tripPart?: TripManagerPart): Promise<string>;
  /** Штатная фраза RU/EN/ZH (requestConfirmNote) — вырезается из частей и ставится один раз. */
  confirmNote: string;
  /**
   * Та же фраза для части, оператор которой мессенджер не подключил (разбор
   * промпта 15.11, п. 3): «оператор свяжется» в конце сводки не обещается,
   * если хоть одна часть уйдёт ему через команду Ведара.
   */
  confirmNoteFor?: (reach: 'none' | 'unknown') => string;
  /** Пробный прогон (`test: true`, lib/mcp/test-run): части проверяются, ничего не записано — сводка так и говорит. */
  test?: boolean;
  newTripId?: () => string;
  /**
   * План по plan_id (аудит планировщика 07.11, M7). Читается один раз на
   * поездку: из него — люди и даты, которых агент не назвал, и номер плана
   * уходит в каждую часть. Нет зависимости — plan_id не читается.
   */
  readPlan?: (planId: string) => Promise<PlanAttach>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * «Не создана» в тексте исполнителя — часть не прошла (исполнители так и
 * отвечают). Правило одно с чатом Кузьмича (`lib/agent/request-outcome`):
 * признак успеха («Ключ статуса заявки», «заявка принята») перевешивает —
 * «план не найден — заявка принята без плана» часть не роняет.
 */
export function legFailed(text: string): boolean {
  return textFailed(text);
}

/** Исполнитель просит выбрать перевозчика — машину берёт менеджер. */
export function needsCarrierChoice(text: string): boolean {
  return /укажите, кому адресовать/i.test(text);
}

const MANAGER_PENDING = '__manager_pending__';

/** Страница поездки: ключи частей — во фрагменте (#), на сервер и в метрику не уходят. */
export function tripPageUrl(tripId: string, keys: string[], base = getPublicBaseUrl()): string {
  return `${base.replace(/\/$/, '')}/trip-request/${tripId}#${keys.join('.')}`;
}

export function newTripId(): string {
  return 'TRIP-' + randomBytes(3).toString('hex').toUpperCase();
}

export async function runTripRequest(raw: Record<string, unknown>, deps: TripDeps): Promise<{ text: string; tripId: string | null; legs: TripLegResult[]; tripUrl?: string | null }> {
  // План (M7): прочитан — его номер уходит в каждую часть, и из него берётся
  // то, чего агент не назвал. Не прочитан — части идут без него, а агент
  // слышит это один раз за поездку, а не в каждой части.
  const planId = str(raw.plan_id);
  const plan: PlanAttach = planId && deps.readPlan ? await deps.readPlan(planId) : { kind: 'none' };
  const facts = plan.kind === 'attached' ? plan.facts : null;
  const fromPlan: string[] = [];

  let people = pickHeadcount(raw);
  if (people === undefined && facts) {
    people = facts.people;
    fromPlan.push(`число людей — ${facts.people}`);
  }
  const tour = str(raw.tour);
  let tourDate = str(raw.tour_date) || str(raw.date);
  // Дата тура — по номеру тура в плане: название тура с планом не сличается.
  if (!tourDate && tour && facts?.tourDates[tour]) {
    tourDate = facts.tourDates[tour];
    fromPlan.push(facts.tourDateNotes[tour] ?? `дата тура — ${tourDate}`);
  }
  /** В день плана мест нет, свободной даты план не знает — дату называет человек. */
  const noFreeDay = !tourDate && tour ? facts?.tourNoFree[tour] : undefined;
  const stay = str(raw.stay) || str(raw.accommodation);
  let checkIn = str(raw.check_in);
  let checkOut = str(raw.check_out);
  const stayAsked = Boolean(stay) || raw.stay_wanted === true || raw.stay_wanted === 'true' || str(raw.lodging) !== '';
  if (stayAsked && facts && (!checkIn || !checkOut)) {
    checkIn ||= facts.arrivalDate;
    checkOut ||= facts.departureDate;
    fromPlan.push(`даты жилья — ${checkIn} — ${checkOut}`);
  }
  const dest = str(raw.transfer_destination) || str(raw.destination);
  const tDate = str(raw.transfer_date) || str(raw.date_from);
  const tDateTo = str(raw.transfer_date_to) || str(raw.date_to);

  const wantTour = Boolean(tour);
  const wantStay = Boolean(stay);
  // Жильё без названия объекта (02.11): отдельная часть «жильё на подбор» —
  // менеджеру Ведара с датами и гостями, а не строчка в комментарии.
  const wantStayMatch = !wantStay && (raw.stay_wanted === true || raw.stay_wanted === 'true' || str(raw.lodging) !== '');
  const wantTransfer = Boolean(dest);
  if (!wantTour && !wantStay && !wantStayMatch && !wantTransfer) {
    return { tripId: null, legs: [], text: 'В поездке нет ни одной части — заявка не создана. Передайте tour+tour_date, stay+check_in+check_out и/или transfer_destination+transfer_date.' };
  }
  const missing: string[] = [];
  if (wantTour && !tourDate) missing.push('tour_date');
  if (wantStay && (!checkIn || !checkOut)) missing.push('check_in/check_out');
  if (wantStayMatch && !checkIn) missing.push('check_in');
  if (wantTransfer && !tDate) missing.push('transfer_date');
  if (missing.length) {
    const why = noFreeDay
      ? ` В плане тур «${tour}» стоит на ${noFreeDay}, но мест в этот день нет, а свободной даты план не знает — спросите у человека другую дату.`
      : '';
    return { tripId: null, legs: [], text: `Не хватает дат: ${missing.join(', ')} — заявка не создана.${why}` };
  }

  const tripId = (deps.newTripId ?? newTripId)();
  const parts: string[] = [];
  if (wantTour) parts.push(`тур «${tour}» ${tourDate}`);
  if (wantStay) parts.push(`жильё «${stay}» ${checkIn}–${checkOut}`);
  if (wantStayMatch) parts.push(`жильё на подбор ${checkIn}${checkOut ? `–${checkOut}` : ''}`);
  if (wantTransfer) parts.push(`машина «${dest}» ${tDate}${tDateTo ? `–${tDateTo}` : ''}`);
  const peopleLine = people !== undefined ? `, ${str(people)} чел.` : '';
  const tripLine = `[Поездка ${tripId}${peopleLine}] В этой же поездке: ${parts.join('; ')}.`;
  const userComment = str(raw.comment);
  const comment = (tripLine + (userComment ? ` ${userComment}` : '')).slice(0, 1000);

  const common = {
    name: raw.name, phone: raw.phone, consent: raw.consent, comment,
    ...(plan.kind === 'attached' ? { plan_id: plan.planId } : {}),
  };
  const legs: TripLegResult[] = [];
  const run = async (kind: LegKind, fn: () => Promise<string>) => {
    try {
      const text = await fn();
      legs.push({ kind, ok: !legFailed(text), text });
    } catch (err) {
      legs.push({ kind, ok: false, text: err instanceof Error ? err.message : 'Часть не создана.' });
    }
  };

  if (wantTour) {
    await run('tour', () => deps.bookTour({ ...common, tour, date: tourDate, ...(people !== undefined ? { participants: people } : {}), notify_url: raw.notify_url }));
  }
  if (wantStay) {
    await run('stay', () => deps.requestStay({ ...common, accommodation: stay, check_in: checkIn, check_out: checkOut, ...(people !== undefined ? { guests: people } : {}) }));
  }
  // Части без адресата (машина без перевозчика, жильё на подбор) — ОДНА
  // заявка менеджеру: две create_lead на один телефон за сутки не пропустит write-guard.
  const manager: { kind: LegKind; line: string }[] = [];
  if (wantTransfer) {
    await run('transfer', async () => {
      const charterArgs = {
        ...common, destination: dest, date_from: tDate, ...(tDateTo ? { date_to: tDateTo } : {}),
        passengers: people ?? 1, ...(str(raw.carrier) ? { carrier: str(raw.carrier) } : {}), notify_url: raw.notify_url,
      };
      const t = await deps.requestCharter(charterArgs);
      if (!needsCarrierChoice(t)) return t;
      manager.push({ kind: 'transfer', line: `Машина под заказ: ${dest}, ${tDate}${tDateTo ? `–${tDateTo}` : ''}, перевозчика подобрать.` });
      return MANAGER_PENDING;
    });
  }
  if (wantStayMatch) {
    legs.push({ kind: 'stay', ok: true, text: MANAGER_PENDING });
    // Третье состояние (§4.0): даты, которых гость не называл, менеджеру не выдаются за названные.
    const inLine = raw.stay_dates_assumed === true ? `заезд ориентировочно ${checkIn} (взят из даты запроса, уточнить)` : `заезд ${checkIn}`;
    const outLine = checkOut ? `выезд ${checkOut}` : 'выезд не назван, уточнить';
    manager.push({ kind: 'stay', line: `Жильё на подбор: ${inLine}, ${outLine}${people !== undefined ? `, гостей ${str(people)}` : ''}.` });
  }
  if (manager.length) {
    let leadText: string;
    let ok = true;
    try {
      leadText = await deps.createLead({
        ...common,
        comment: `${comment} ${manager.map((m) => m.line).join(' ')}`.slice(0, 2000),
        interest: manager.map((m) => (m.kind === 'stay' ? 'Жильё на подбор' : 'Трансфер / машина под заказ')).join(' + '),
        ...(people !== undefined ? { participants: people } : {}),
      }, {
        tripId,
        parts: manager.map((m) => (m.kind === 'stay' ? 'stay' as const : 'transfer' as const)),
      });
      ok = !legFailed(leadText);
    } catch (err) {
      leadText = err instanceof Error ? err.message : 'Часть не создана.';
      ok = false;
    }
    const what = (k: LegKind) => (k === 'stay' ? 'Жильё подберёт менеджер Ведара (объект не назван)' : 'Машину подберёт менеджер Ведара (перевозчик не выбран)');
    manager.forEach((m, i) => {
      const leg = legs.find((l) => l.kind === m.kind && l.text === MANAGER_PENDING);
      if (!leg) return;
      leg.ok = ok;
      leg.text = i === 0 ? `${what(m.kind)}: ${leadText}` : `${what(m.kind)} — в той же заявке менеджеру.`;
    });
  }

  // Другие туры плана (разбор планера 14.11, Кузьмич/MCP-8): заявка берёт
  // один тур, и «создано частей 2 из 2» читалось как «заказан весь план»,
  // хотя операторы остальных туров заявки не получали.
  const planTours = facts ? [...new Set([...Object.keys(facts.tourDates), ...Object.keys(facts.tourNoFree)])] : [];
  const others = planTours.filter((id) => id !== tour);
  const otherPlanTours = others.length > 0 && !deps.test
    ? ` В плане есть и другие туры (${others.map((id) => `ID${id}`).join(', ')}) — по ним заявки нет: каждый тур — своя заявка (create_booking_request с его ID), если человек их хочет.`
    : '';

  const LABEL: Record<LegKind, string> = { tour: 'Тур', stay: 'Жильё', transfer: 'Машина' };
  // Фраза у части может быть своим вариантом (оператор без мессенджера) —
  // вырезается любой, а строка о передаче остаётся в тексте части.
  const strip = (t: string) => (deps.confirmNote ? t.split(deps.confirmNote).join('') : t)
    .replace(/\n\nСкажи человеку его языком:[\s\S]*?из-за ограничений\./g, '').trim();
  const legsText = legs.map((l) => l.text).join('\n');
  const finalNote = deps.confirmNoteFor && legsText.includes(OPERATOR_NO_CHANNEL_MARK) ? deps.confirmNoteFor('none')
    : deps.confirmNoteFor && legsText.includes(OPERATOR_REACH_UNKNOWN_MARK) ? deps.confirmNoteFor('unknown')
    : deps.confirmNote;
  const okCount = legs.filter((l) => l.ok).length;
  const head = (deps.test
    ? `Поездка ${tripId} (проба, test: true): проверки прошли у частей ${okCount} из ${legs.length}; ничего не записано и никому не передано.`
    : okCount === 0
      ? `Поездка ${tripId}: ни одна часть не создана.`
      : `Поездка ${tripId}: создано частей ${okCount} из ${legs.length}. Каждый партнёр видит в заявке всю поездку (номер ${tripId}).`)
    + (fromPlan.length ? ` Из плана взято: ${fromPlan.join('; ')}.` : '')
    + planAttachNote(plan)
    + otherPlanTours;
  const keys = [...new Set(legs.flatMap((l) => [...l.text.matchAll(/Ключ статуса заявки: ([\w-]{16,64})/g)].map((m) => m[1])))];
  const tripUrl = okCount > 0 && keys.length ? tripPageUrl(tripId, keys) : null;
  const tripNote = tripUrl ? `\nВся поездка одной ссылкой для человека: ${tripUrl} (части, статус каждой, согласие). Ссылку не публикуйте.` : '';
  const done = deps.test ? 'проверено' : 'создано';
  const body = legs.map((l) => `— ${LABEL[l.kind]}: ${l.ok ? done : 'НЕ создано'}. ${strip(l.text)}`).join('\n');
  return { tripId, legs, tripUrl, text: `${head}\n${body}${tripNote}${okCount > 0 && !deps.test ? finalNote : ''}` };
}
