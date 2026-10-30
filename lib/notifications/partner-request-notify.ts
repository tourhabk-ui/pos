/**
 * Заявка на машину (перевозчику) или на прокат (прокатчику) — ЛИЧНО партнёру
 * в его MAX или Telegram (23.10, «Лагуна Прокат»; до этого дня такие заявки
 * доходили только менеджеру Ведара и в CRM).
 *
 * Почему не `notifyPartnerNewLeadPersonally` (lib/notifications/lead-notify):
 * та написана для туроператора — её единственная кнопка ведёт в кабинет
 * оператора `/hub/operator/leads/<id>`, куда у партнёра категории `transfer`
 * роли нет, а заглушка для Telegram обещает «имя и телефон — в кабинете».
 * У перевозчика и прокатчика кабинета заявок на сайте нет: партнёру нужно
 * знать, ЧТО просят и КТО, — и ответить кнопкой.
 *
 * Правила те же, что у личной доставки оператору:
 *   · адрес — только партнёра (`reachForPartner` → `sendPdAlert({ to })`,
 *     строго, без отката на рабочий чат платформы);
 *   · ПД (имя, телефон, пожелания) — только в тексте для MAX; в заглушке для
 *     Telegram их нет, и она зовёт не в кабинет на сайте, а во «Входящие»
 *     кабинета в чате — там карточка заявки с теми же кнопками;
 *   · под текстом для MAX две кнопки «Беру» / «Не могу» (`rr:`): у заявки на
 *     машину — каждому перевозчику (#2862 этап A, 30.10: до этого дня заявку
 *     на машину вёл только менеджер, а перевозчик ответить через платформу
 *     не мог), у заявки на прокат — пилоту (`RENTAL_OPERATOR_PILOT_SLUGS`,
 *     без переменной — `laguna-prokat`). Это действия, не ссылки: в заглушку
 *     Telegram они не попадают (`pd-alert` отдаёт туда только кнопки с url,
 *     этот файл не трогает);
 *   · исходы — четыре (§4.0): доставлено / заглушка / нет канала / адрес не
 *     прочитался, и каждый, кроме доставки, назван в логе без ПД.
 *
 * Факты заявки сюда приходят уже строками (`charterRequestLines`,
 * `rentalRequestLines`): без телефона партнёра и без заметок менеджеру —
 * комментарий лида для партнёра не годится дословно.
 *
 * Сторож: tests/unit/partner-request-notify.test.ts.
 */

import { sendPdAlert, type PdAlertButton } from '@/lib/notifications/pd-alert';
import { reachForPartner } from '@/lib/partners/reach';
import type { PersonalLeadOutcome } from '@/lib/notifications/lead-notify';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { rentalAnswerButtons } from '@/lib/rental/request-answer';
import { isChatTargetId, ownerReplyButton } from '@/lib/requests/request-chat';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type PartnerRequestKind = 'charter' | 'car_rental';

export interface PartnerRequestNotice {
  partnerId: string;
  leadId: string;
  kind: PartnerRequestKind;
  /** Факты заявки без ПД, по строке на факт: направление, даты, машина, цена по прайсу. */
  lines: readonly string[];
  name: string;
  phone: string;
  comment: string | null;
  /** Slug прокатчика. У заявки на прокат кнопки «Беру» / «Не могу» — только у пилота. */
  companySlug?: string | null;
}

const HEADLINE: Record<PartnerRequestKind, string> = {
  charter: 'Новая заявка на машину с Ведара',
  car_rental: 'Новая заявка на прокат с Ведара',
};

/**
 * «Беру» / «Не могу» — только с uuid заявки: на машину — каждому
 * перевозчику, на прокат — пилоту.
 */
function answerButtons(n: PartnerRequestNotice): PdAlertButton[] {
  if (n.kind === 'car_rental' && !isRentalPilotSlug(n.companySlug)) return [];
  return rentalAnswerButtons(n.leadId) ?? [];
}

/**
 * Кнопки под заявкой: «Ответить клиенту» — переписка с заказчиком в этом же
 * чате (1350) — у каждой заявки с uuid; следом «Беру» / «Не могу». Нет ни
 * одной — undefined.
 */
export function partnerRequestButtons(n: PartnerRequestNotice): PdAlertButton[] | undefined {
  const reply = isChatTargetId(n.leadId) ? [ownerReplyButton({ kind: 'lead', id: n.leadId })] : [];
  const all = [...reply, ...answerButtons(n)];
  return all.length > 0 ? all : undefined;
}

/** Что делают кнопки ответа — по виду заявки. У прокатчика «Беру» ещё и занимает дни. */
const ANSWER_LINE: Record<PartnerRequestKind, string> = {
  charter: '«Беру» — вы готовы выполнить и свяжетесь с заказчиком сами; «Не могу» — заявка остаётся у менеджера Ведара. Машина заявкой не закрепляется.',
  car_rental: '«Беру» отмечает эти дни занятыми. «Не могу» дни не занимает.',
};

/** Текст с ПД (MAX) и заглушка без ПД (Telegram) из одних фактов. */
export function partnerRequestTexts(n: PartnerRequestNotice): { text: string; stub: string } {
  const common = [`<b>${HEADLINE[n.kind]}</b>`, ...n.lines.map((l) => esc(l))];
  const answers = answerButtons(n).length > 0;
  const reply = isChatTargetId(n.leadId);
  const text = [
    ...common,
    '',
    `<b>Имя:</b> ${esc(n.name)}`,
    `<b>Телефон:</b> ${esc(n.phone)}`,
    n.comment ? `<b>Пожелания:</b> ${esc(n.comment.slice(0, 200))}` : '',
    '',
    // Перевозчик с кнопками отвечает сам; без кнопок (id не uuid) и у проката заказ согласует менеджер.
    n.kind === 'charter' && answers
      ? 'Ответьте кнопкой ниже — заказчик и менеджер Ведара узнают ваш ответ.'
      : 'Менеджер Ведара согласует заказ с вами и подтвердит заказчику.',
    reply ? 'Написать заказчику в этом чате — кнопка «Ответить клиенту».' : '',
    answers ? ANSWER_LINE[n.kind] : '',
  ].filter(Boolean).join('\n');
  const stub = [
    ...common,
    '',
    `Заявка <code>${esc(n.leadId)}</code> принята.`,
    'Контакты заказчика — у менеджера Ведара: в Telegram они не передаются.',
    n.kind === 'charter' && answers
      ? 'Ответить «Беру» или «Не могу» — в карточке заявки во «Входящих» (кнопка «Входящие» под сообщениями бота).'
      : '',
  ].filter(Boolean).join('\n');
  return { text, stub };
}

export async function notifyPartnerRequestPersonally(n: PartnerRequestNotice): Promise<PersonalLeadOutcome> {
  const { text, stub } = partnerRequestTexts(n);

  const reach = await reachForPartner(n.partnerId);
  if (reach === null) {
    console.error(`[partner-request-notify] адрес партнёра ${n.partnerId} не прочитался — о заявке ${n.leadId} лично не сообщено`);
    return { state: 'unknown' };
  }
  if (!reach.reachable) {
    console.error(`[partner-request-notify] у партнёра ${n.partnerId} нет ни MAX, ни Telegram — заявка ${n.leadId} остаётся у менеджера`);
    return { state: 'no_channel' };
  }

  const res = await sendPdAlert({
    text,
    stub,
    buttons: partnerRequestButtons(n),
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return { state: 'delivered', channel: 'max' };
  if (res.channel === 'telegram-stub') return { state: 'stub', channel: 'telegram-stub' };
  console.error(`[partner-request-notify] партнёру ${n.partnerId} о заявке ${n.leadId} лично не доставлено (${res.channel}) — ${res.reason}`);
  return { state: 'failed', channel: res.channel, reason: res.reason };
}
