/**
 * Пять действий строки кабинета прокатчика. Каждое уже умеет отвечать
 * само: прайс, календарь, заявки с «Беру» / «Не могу», черновики, справка.
 * Кнопку строки к ответу клеит вызывающий — здесь только содержимое.
 */

import { runOperatorRentalFleet } from '@/lib/kuzmich/operator-rental-fleet';
import { rentalCabinetHelp, type CabinetButton, type RentalCabinetAction } from '@/lib/rental/cabinet-bar';
import { loadCabinetEdits, loadCabinetRequests, rentalEditsText, rentalRequestsView } from '@/lib/rental/cabinet-read';
import { handleRentalCalendarText } from '@/lib/rental/car-calendar-flow';

export interface CabinetPartner {
  partnerId: string;
  partnerName: string;
  slug?: string | null;
}

export async function openRentalCabinetScreen(opts: {
  action: RentalCabinetAction;
  partner: CabinetPartner;
  channel: 'max' | 'telegram';
  nowMs?: number;
  dialog: boolean;
  send: (text: string, buttons: CabinetButton[][]) => Promise<void>;
}): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  if (opts.action === 'help') {
    await opts.send(rentalCabinetHelp(), []);
    return;
  }
  if (opts.action === 'fleet') {
    const text = await runOperatorRentalFleet(
      opts.partner.partnerId,
      opts.partner.partnerName,
      opts.partner.slug ?? null,
      {},
      nowMs,
    );
    await opts.send(text, []);
    return;
  }
  if (opts.action === 'calendar') {
    await handleRentalCalendarText({
      partner: { ...opts.partner, slug: opts.partner.slug ?? null },
      text: 'календарь',
      nowMs,
      dialog: opts.dialog,
      canMark: opts.channel === 'max',
      send: async (text, buttons) => { await opts.send(text, buttons); },
    });
    return;
  }
  if (opts.action === 'requests') {
    const view = rentalRequestsView(await loadCabinetRequests(opts.partner.partnerId), opts.channel);
    await opts.send(view.text, view.buttons);
    return;
  }
  await opts.send(rentalEditsText(await loadCabinetEdits(opts.partner.partnerId)), []);
}
