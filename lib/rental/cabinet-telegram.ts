/**
 * Кабинет прокатчика на живом входе Telegram (/api/telegram/webhook).
 *
 * Второй вход /api/telegram/kuzmich вебхуком не зарегистрирован. Строка
 * кнопок и пять действий должны отвечать здесь, иначе прокатчик их не
 * увидит. Чужой чат и просьба туриста в этом чате сюда не попадают:
 * вызывающий получает false и идёт прежним путём.
 */

import { findPartnerByChat, processPartnerMessage } from '@/lib/kuzmich/operator-chat';
import { boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { withSosBlock } from '@/lib/safety/sos-detector';
import {
  parseRentalCabinetPress, rentalCabinetAsk,
  type CabinetButton,
} from '@/lib/rental/cabinet-bar';
import { openRentalCabinetScreen } from '@/lib/rental/cabinet-screen';
import { handleRentalCalendarText } from '@/lib/rental/car-calendar-flow';
import { isRentalPilotSlug, rentalPilotTelegramGreeting } from '@/lib/rental/operator-pilot';
import { handleRentalRequestAnswer } from '@/lib/rental/request-answer-flow';
import { handleRideOutcomePress } from '@/lib/transfers/ride-outcome-flow';
import { isRideOutcomePayload } from '@/lib/transfers/ride-outcome';

export type CabinetSend = (text: string, buttons: CabinetButton[][]) => Promise<void>;

const NOT_THIS_CHAT = 'Эта кнопка — кабинет проката. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';

/**
 * true — ответил кабинет прокатчика. false — это не его чат или просьба
 * туриста, и отвечать должен прежний путь.
 */
export async function tryRentalCabinetTelegramMessage(opts: {
  chatId: number;
  text: string;
  fromName: string | null;
  send: CabinetSend;
}): Promise<boolean> {
  const lookup = await findPartnerByChat('telegram', opts.chatId);
  if (lookup.outcome !== 'found' || !isRentalPilotSlug(lookup.partner.slug)) return false;
  if (boundChatLaneFor('telegram', opts.chatId, opts.text, { rental: true }) === 'tourist') return false;

  const partner = lookup.partner;
  // Беда в тексте — блок 112 над любым ответом кабинета (календарь, экраны,
  // помощник): команда кабинета в той же фразе остаётся здесь.
  const send: CabinetSend = (text, buttons) => opts.send(withSosBlock(text, opts.text).text, buttons);
  if (opts.text.trim() === '/start') {
    await send(rentalPilotTelegramGreeting(partner.partnerName), []);
    return true;
  }
  const asked = rentalCabinetAsk(opts.text);
  if (asked === 'requests' || asked === 'edits' || asked === 'help' || asked === 'fleet' || asked === 'calendar') {
    await openRentalCabinetScreen({
      action: asked,
      partner: { partnerId: partner.partnerId, partnerName: partner.partnerName, slug: partner.slug },
      channel: 'telegram',
      dialog: true,
      send,
    });
    return true;
  }
  const calendar = await handleRentalCalendarText({
    partner,
    text: opts.text,
    nowMs: Date.now(),
    dialog: true,
    canMark: false,
    send: async (text, buttons) => { await send(text, buttons); },
  });
  if (calendar) return true;
  await processPartnerMessage({
    chatId: opts.chatId,
    text: opts.text,
    fromName: opts.fromName,
    partner,
    reply: async (_id, text) => { await send(text, []); },
  });
  return true;
}

/**
 * true — payload наш (rk: или rr:) и ответ уже отправлен.
 *
 * `rr:` («Беру» / «Не могу») принимается у любого привязанного партнёра:
 * вид заявки — прокат пилота или машина перевозчика (#2862) — решает поток
 * по лиду. Перевозчику ответ уходит `sendBare` (без строки кабинета
 * проката — она не его); нет `sendBare` — обычным `send`. Строка `rk:` —
 * по-прежнему только пилот.
 */
export async function tryRentalCabinetTelegramPress(opts: {
  chatId: number;
  payload: string;
  send: CabinetSend;
  /** Ответ без строки кабинета проката — партнёру не из пилота. */
  sendBare?: (text: string) => Promise<void>;
}): Promise<boolean> {
  const action = parseRentalCabinetPress(opts.payload);
  const request = opts.payload.startsWith('rr:');
  const ride = isRideOutcomePayload(opts.payload);
  if (!action && !request && !ride) return false;

  const lookup = await findPartnerByChat('telegram', opts.chatId);
  if (lookup.outcome === 'unavailable') {
    await opts.send(UNREAD, []);
    return true;
  }
  if (request || ride) {
    const pilot = lookup.outcome === 'found' && isRentalPilotSlug(lookup.partner.slug);
    const bare = opts.sendBare;
    const send = async (text: string) => {
      if (!pilot && bare) await bare(text);
      else await opts.send(text, []);
    };
    // Исход поездки перевозчика (#2862 этап B) — своей же полосой, без строки проката.
    if (ride) {
      await handleRideOutcomePress({ lookup, payload: opts.payload, editMid: null, originalText: null, via: 'telegram', send });
      return true;
    }
    await handleRentalRequestAnswer({
      lookup,
      payload: opts.payload,
      editMid: null,
      originalText: null,
      via: 'telegram',
      send,
    });
    return true;
  }
  if (lookup.outcome !== 'found' || !isRentalPilotSlug(lookup.partner.slug)) {
    await opts.send(NOT_THIS_CHAT, []);
    return true;
  }
  const partner = lookup.partner;
  await openRentalCabinetScreen({
    action: action!,
    partner: { partnerId: partner.partnerId, partnerName: partner.partnerName, slug: partner.slug },
    channel: 'telegram',
    dialog: true,
    send: opts.send,
  });
  return true;
}
