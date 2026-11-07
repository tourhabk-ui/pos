/**
 * Кузьмич в веб-чате сам создаёт заявку (01.11, разбор «где рвётся»):
 * если в реплике есть тур/дата/люди И имя, телефон и явное согласие —
 * заявка уходит через тот же исполнитель, что MCP (runPublicTool), а не
 * остаётся карточкой в интерфейсе. Мульти-намерение (тур + жильё/трансфер)
 * → одна заявка-поездка create_trip_request.
 */
import { requestOutcome, humanReason, LEG_WORD } from '@/lib/agent/request-outcome';

export interface ChatContact { name?: string; phone?: string; consent: boolean; phones?: number }

const PHONE_RE = /(?:\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/g;
const NAME_STOP = /^(?:телефон|тел|номер|согласен|согласна|согласны|даю|phone|tel|consent|agree|хочу|на|в|из|и|а|для|с|по)$/i;

/**
 * Согласие на обработку данных — только явное и без отрицания (#2967).
 * «не согласен», «без согласия», «disagree», «不同意» — не согласие;
 * «согласен на любую дату» — согласие с датой, а не с обработкой данных.
 */
export function chatConsent(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  if (/disagree|do not agree|don'?t agree|no consent|不同意/.test(t)) return false;
  if (/несоглас|(?:^|[^а-я])(?:не|без|нет)\s+(?:[а-я]+\s+)?соглас/.test(t)) return false;
  if (/(?:^|[^a-z])(?:i\s+)?(?:consent|agree)(?![a-z])/.test(t) || /同意/.test(t)) return true;
  for (const m of t.matchAll(/(?:^|[^а-я])(согласен|согласна|согласны|согласие|даю согласие)(?![а-я])(\s+на\s+(\S+))?/g)) {
    const object = m[3];
    if (!object || /^(?:обработ|передач|персональ|данн|услов|пд$|правил)/.test(object)) return true;
  }
  return false;
}

export function parseChatContact(text: string): ChatContact {
  const out: ChatContact = { consent: chatConsent(text) };
  // Два разных номера («мой и сестры») — какой из них звонить, не угадываем: переспрос.
  const phones = [...new Set([...text.matchAll(PHONE_RE)].map((m) => m[0].replace(/\D/g, '').slice(-10)))];
  if (phones.length === 1) out.phone = [...text.matchAll(PHONE_RE)][0][0].replace(/[^\d+]/g, '');
  if (phones.length > 1) out.phones = phones.length;
  // Имя — после «меня зовут», «имя:», «я — …» в начале слова; «для меня - Горелый» — не имя.
  const nm = /(?:[Мм]еня зовут|(?<![А-Яа-яЁё])[Ии]мя[:\s]+|(?<![А-Яа-яЁё])[Яя]\s*[—-]\s*|[Mm]y name is|(?<![A-Za-z])[Nn]ame[:\s]+)\s*([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]+(?:\s+[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]+)?)/u.exec(text);
  if (nm) {
    const words = nm[1].split(/\s+/).filter((w) => !NAME_STOP.test(w));
    if (words.length && !NAME_STOP.test(nm[1].split(/\s+/)[0])) out.name = words.join(' ');
  }
  return out;
}

const NEG_BEFORE = /(?:^|[^а-яё])(?:без|не нуж[а-яё]*|не надо|не требуется|сво[йяеё]|у нас есть)\s*(?:[а-яё]+\s+)?$/i;
const NEG_AFTER = /^[а-яё]*\s*(?:[,—-]\s*)?(?:не\s+(?:нуж|надо|требу|ищ|интерес)|уже\s+есть|есть(?![а-яё])|сво[йяеё](?![а-яё]))/i;

/** Есть ли упоминание, не погашенное отрицанием («без жилья», «трансфер не нужен»). */
function mentioned(text: string, re: RegExp): boolean {
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    const before = text.slice(Math.max(0, i - 24), i);
    const after = text.slice(i + m[0].length, i + m[0].length + 30);
    if (NEG_BEFORE.test(before) || NEG_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

/** Жильё: границы слов — «хотел» не «отель» (#2967). */
export function chatWantsStay(t: string): boolean {
  return mentioned(t, /(?<![а-яё])(?:прожив|жиль|жилье|гостиниц|гостев|домик|база отдыха|ночлег|ночёвк|ночевк|отел[ьяеиюё])[а-яё]*/gi);
}
/** Трансфер: «автобусный тур» — тур, не трансфер. */
export function chatWantsTransfer(t: string): boolean {
  return mentioned(t, /(?<![а-яё])(?:трансфер[а-яё]*|автобус(?!н)[а-яё]*|микроавтобус(?!н)[а-яё]*|довез[а-яё]*|подвез[а-яё]*|встрет(?:ить|ьте|ите|ят)|из аэропорта|из елизово)/gi);
}

export interface ChatRequestPlan { tool: 'create_booking_request' | 'create_trip_request' | 'create_lead'; args: Record<string, unknown> }

export function planChatRequest(
  text: string,
  tour: { id: number } | null,
  prefill: { date?: string; dateEnd?: string; guests?: number },
  opts: { planId?: string | null } = {},
): ChatRequestPlan | null {
  const c = parseChatContact(text);
  if (!c.phone || !c.name || !c.consent || !prefill.date) return null;
  const stay = chatWantsStay(text);
  const transfer = chatWantsTransfer(text);
  // Число людей не названо — поле не передаётся, а не «1 чел.» (#2967):
  // оператор и перевозчик видели бы выдуманную цифру.
  const people = prefill.guests;
  const peopleWords = people ? `${people} чел.` : 'число людей не названо';
  // Диапазон («с 5 по 12 июля», аудит 07.11, K6): заявка уходит на его начало,
  // а весь диапазон стоит словами — день тура человек не называл, и это
  // сказано, а не выдано за его слово.
  const datesWords = prefill.dateEnd ? `${prefill.date} — ${prefill.dateEnd}` : prefill.date;
  const rangeNote = prefill.dateEnd
    ? `[Даты поездки: ${datesWords}; день тура не назван — поставлено начало поездки, уточнит оператор] `
    : '';
  const base: Record<string, unknown> = { name: c.name, phone: c.phone, consent: true, comment: `${rangeNote}${text}`.slice(0, 500) };
  if (people) base.participants = people;
  // План разговора (K6): с ним заявка уходит частью этой поездки — даты и
  // состав плана видит исполнитель, а расхождение с ним называет ответ.
  if (opts.planId) base.plan_id = opts.planId;
  if (!tour && !stay && !transfer) {
    // Тур по реплике не определён однозначно — заявка всё равно уходит:
    // менеджеру на подбор, с датой и числом людей (ретест 01.11: чат
    // отвечал «оставлю заявку?», а заявки не было).
    const args: Record<string, unknown> = { name: c.name, phone: c.phone, consent: true, comment: `[${datesWords}, ${peopleWords}] ${text}`.slice(0, 1000) };
    if (people) args.participants = people;
    if (opts.planId) args.plan_id = opts.planId;
    return { tool: 'create_lead', args };
  }
  if (stay || transfer || !tour) {
    const args: Record<string, unknown> = { ...base };
    if (!people) args.comment = `[${peopleWords}] ${rangeNote}${text}`.slice(0, 500);
    if (tour) { args.tour = String(tour.id); args.tour_date = prefill.date; }
    // Жильё без названия объекта нельзя адресовать хозяину — пожелание
    // уходит в комментарий поездки (его видят все партнёры), не теряется.
    if (stay) {
      args.stay_wanted = true;
      args.check_in = prefill.date;
      if (prefill.dateEnd) {
        // Диапазон назван — заезд и выезд его слова, а не оценка.
        args.check_out = prefill.dateEnd;
      } else {
        // Гость назвал одну дату (тура или запроса): заезд из неё — оценка, а не его слово.
        args.stay_dates_assumed = true;
        const nights = /(\d{1,2})\s*(?:ноч|сут)/i.exec(text);
        if (nights) args.check_out = addDays(prefill.date, Math.min(30, Number(nights[1])));
      }
    }
    if (transfer) { args.transfer_destination = 'по заявке, см. комментарий'; args.transfer_date = prefill.date; }
    return { tool: 'create_trip_request', args };
  }
  // Заявка на тур проверяет места на число людей: без числа проверять нечего,
  // а «1» по умолчанию прошло бы там, где группе мест нет. Спросим в чате.
  if (!people) return null;
  return { tool: 'create_booking_request', args: { ...base, tour: String(tour.id), date: prefill.date } };
}

/**
 * Текст инструмента написан для агента (ключ, «не публикуйте», RU/EN/ZH).
 * Человеку в чате — его собственная заявка: номер, ссылка статуса, порядок.
 * «Создана» говорится только по признаку успеха исполнителя (#2967):
 * отказ текстом — «Заявка не создана: причина», нет признака — «не знаю».
 */
export function humanChatConfirm(toolText: string, tourTitle?: string | null): string {
  const o = requestOutcome(toolText);
  if (o.kind === 'not_created') return chatRequestNotCreated(o.reason, { answered: true });
  if (o.kind === 'unknown') return chatRequestUnconfirmed();
  const tripUrl = /https:\/\/\S+\/trip-request\/TRIP-[A-Z0-9]+#[\w.-]+/.exec(toolText)?.[0];
  const links = [...new Set(toolText.match(/https:\/\/vedarai\.ru\/request-status#[\w-]+/g) ?? [])];
  const parts: string[] = [];
  let tourCreated = true;
  if (o.trip) {
    const made = o.legs.filter((l) => l.created).map((l) => LEG_WORD[l.name]);
    const failed = o.legs.filter((l) => !l.created);
    tourCreated = o.legs.some((l) => l.name === 'tour' && l.created);
    parts.push(`Заявка на поездку создана, номер ${o.trip}${made.length ? ` (${made.join(', ')})` : ''}.`);
    for (const f of failed) parts.push(`Не создано: ${LEG_WORD[f.name]}${f.reason ? ` — ${f.reason}` : ''}. Эту часть можно попросить ещё раз.`);
  } else if (o.seatRequest) {
    const by = /ответ будет до ([\d:]+)/.exec(toolText)?.[1];
    parts.push(`Запрос мест отправлен оператору: у тура нет расписания в системе${by ? `, ответ будет до ${by} по Камчатке` : ''}. Места этим запросом не закреплены.`);
  } else parts.push('Заявка создана.');
  // Какой тур в заявке — словами, чтобы человек сразу увидел ошибку выбора.
  const tt = tourTitle?.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (tt && tourCreated) parts.push(`Тур в заявке: «${tt}». Если не тот — напишите название тура, поправим. EN: Tour in the request: «${tt}». ZH: 申请中的线路：«${tt}»。`);
  parts.push('Оператор свяжется с вами по указанному телефону для подтверждения. Мгновенного бронирования нет — подтверждает человек, оплата не через платформу.');
  if (tripUrl) parts.push(`Вся поездка, статус каждой части и согласие на обработку данных: ${tripUrl}`);
  else if (links.length) parts.push(`Статус заявки и согласие на обработку данных: ${links.join(' , ')}`);
  parts.push('EN: Request created — the operator will contact you to confirm; no instant booking, no payment through the platform. ZH: 请求已提交，运营方会联系您确认；无即时预订，平台不收款。');
  return parts.join('\n\n');
}

/** Был ли текст исполнителя успехом — тем же правилом, что ответ человеку. */
export function chatRequestCreated(toolText: string): boolean {
  return requestOutcome(toolText).kind === 'created';
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Та же заявка из мессенджеров (02.11, «го» владельца): шаги брони Кузьмича
 * в MAX собирают тур, имя, дату, людей и телефон, «Да» на строке согласия —
 * и заявка уходит тем же исполнителем, что веб-чат и MCP
 * (create_booking_request), а не отдельной записью брони.
 */
export function planFromBookingFlow(f: {
  tourId: number; name: string; phone: string; date: string; participants: number; comment?: string;
}): ChatRequestPlan {
  return {
    tool: 'create_booking_request',
    args: {
      name: f.name, phone: f.phone, consent: true, participants: f.participants,
      tour: String(f.tourId), date: f.date,
      comment: (f.comment ?? 'Заявка из чата Кузьмича в MAX').slice(0, 500),
    },
  };
}

/** Заявка не создалась: без «сервис недоступен», с честным следующим шагом. */
export function chatRequestNotCreated(reason?: string | null, opts: { answered?: boolean } = {}): string {
  const r = humanReason(reason);
  return [
    r ? `Заявка не создана: ${r}` : opts.answered ? 'Заявка не создана.' : 'Заявка не записалась — ответ базы не пришёл.',
    'Можно поправить данные и написать ещё раз или оформить заявку в форме тура на сайте.',
  ].join('\n');
}

/**
 * Исполнитель ответил, но ни успеха, ни отказа в ответе нет (§4.0, третий
 * исход): звонка не обещаем — человек не должен ждать того, чего может не быть.
 */
export function chatRequestUnconfirmed(): string {
  return [
    'Не могу подтвердить, что заявка записалась: ответ системы без признака записи.',
    'Если звонка не будет в течение дня — оформите заявку в форме тура на сайте или напишите сюда ещё раз, дубль не создастся.',
  ].join('\n');
}

/**
 * Ответ человеку на исход исполнителя — одно правило для веб-чата (оба пути),
 * MAX и Telegram (#2967). `created` — только по признаку успеха в тексте:
 * `kind: 'ok'` у runPublicTool значит «исполнитель ответил», а не «заявка есть».
 */
export function chatToolReply(
  out: { kind: string; text?: string } | null,
  tourTitle?: string | null,
): { created: boolean; text: string } {
  if (!out) return { created: false, text: chatRequestNotCreated(null) };
  if (out.kind === 'ok' && typeof out.text === 'string') {
    return { created: chatRequestCreated(out.text), text: humanChatConfirm(out.text, tourTitle) };
  }
  if ((out.kind === 'refused' || out.kind === 'rate_limited') && typeof out.text === 'string') {
    return { created: false, text: chatRequestNotCreated(out.text, { answered: true }) };
  }
  return { created: false, text: chatRequestNotCreated(null) };
}

/** Названа прошедшая дата («15.11.24»): заявку не отправляем, переспрашиваем (#2967). */
export function chatPastDateAsk(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `Дата ${d}.${m}.${y} уже прошла — заявку на неё не отправляю. Напишите дату поездки, и я оформлю заявку.`;
}
