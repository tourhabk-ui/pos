/**
 * Кузьмич в веб-чате сам создаёт заявку (01.11, разбор «где рвётся»):
 * если в реплике есть тур/дата/люди И имя, телефон и явное согласие —
 * заявка уходит через тот же исполнитель, что MCP (runPublicTool), а не
 * остаётся карточкой в интерфейсе. Мульти-намерение (тур + жильё/трансфер)
 * → одна заявка-поездка create_trip_request.
 */
export interface ChatContact { name?: string; phone?: string; consent: boolean }

export function parseChatContact(text: string): ChatContact {
  const out: ChatContact = { consent: false };
  const ph = /(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/.exec(text);
  if (ph) out.phone = ph[0].replace(/[^\d+]/g, '');
  const nm = /(?:[Мм]еня зовут|[Ии]мя[:\s]+|[Яя]\s*[—-]\s*|[Mm]y name is|[Nn]ame[:\s]+)\s*([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]+(?:\s+[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]+)?)/u.exec(text);
  if (nm) out.name = nm[1];
  out.consent = /(соглас|даю согласие|consent|agree|同意)/i.test(text);
  return out;
}

export function chatWantsStay(t: string): boolean { return /(прожив|жиль|гостиниц|гостев|домик|база отдыха|ночл|отел)/i.test(t); }
export function chatWantsTransfer(t: string): boolean { return /(трансфер|автобус|микроавтобус|довез|подвез|встрет[ья]|из аэропорта|из елизово)/i.test(t); }

export interface ChatRequestPlan { tool: 'create_booking_request' | 'create_trip_request' | 'create_lead'; args: Record<string, unknown> }

export function planChatRequest(
  text: string,
  tour: { id: number } | null,
  prefill: { date?: string; guests?: number },
): ChatRequestPlan | null {
  const c = parseChatContact(text);
  if (!c.phone || !c.name || !c.consent || !prefill.date) return null;
  const stay = chatWantsStay(text);
  const transfer = chatWantsTransfer(text);
  const base = { name: c.name, phone: c.phone, consent: true, participants: prefill.guests ?? 1, comment: text.slice(0, 500) };
  if (!tour && !stay && !transfer) {
    // Тур по реплике не определён однозначно — заявка всё равно уходит:
    // менеджеру на подбор, с датой и числом людей (ретест 01.11: чат
    // отвечал «оставлю заявку?», а заявки не было).
    return { tool: 'create_lead', args: { name: c.name, phone: c.phone, consent: true, comment: `[${prefill.date}, ${prefill.guests ?? 1} чел.] ${text}`.slice(0, 1000) } };
  }
  if (stay || transfer || !tour) {
    const args: Record<string, unknown> = { ...base };
    if (tour) { args.tour = String(tour.id); args.tour_date = prefill.date; }
    // Жильё без названия объекта нельзя адресовать хозяину — пожелание
    // уходит в комментарий поездки (его видят все партнёры), не теряется.
    if (stay) args.comment = `Нужно жильё. ${String(args.comment)}`.slice(0, 500);
    if (transfer) { args.transfer_destination = 'по заявке, см. комментарий'; args.transfer_date = prefill.date; }
    if (!tour && !transfer) return null;
    return { tool: 'create_trip_request', args };
  }
  return { tool: 'create_booking_request', args: { ...base, tour: String(tour.id), date: prefill.date } };
}
