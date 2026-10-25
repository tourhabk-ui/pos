/**
 * «цена …» и «описание …:» в чате пилота. Модель эту фразу не обрабатывает:
 * цену она уже выдумывала, когда инструмента не было.
 *
 * Черновик не меняет живую строку. Не пилот и обычный разговор — null,
 * помощник отвечает как раньше.
 */

import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  isOfferEditAsk, offerEditAmbiguousText, offerEditDbErrorText, offerEditFormatHint,
  offerEditMissingText, offerEditRejectText, offerEditSavedText, offerEditSpacedPriceText, parseOfferEdit,
} from '@/lib/rental/offer-edit';
import { findOwnedOffer, savePendingOfferEdit } from '@/lib/rental/offer-edit-store';

export async function handleRentalOfferEdit(opts: {
  partnerId: string;
  slug: string | null;
  text: string;
}): Promise<string | null> {
  if (!isRentalPilotSlug(opts.slug) || !isOfferEditAsk(opts.text)) return null;
  const parsed = parseOfferEdit(opts.text);
  if (!parsed.ok) {
    return parsed.reason === 'format' || parsed.reason === 'not_edit'
      ? offerEditFormatHint()
      : offerEditRejectText(parsed);
  }
  const command = parsed.command;
  // «цена Jimny 8 500»: машины «Jimny» в прайсе есть — значит, это цена с
  // пробелом, а не машина «Jimny 8». Какое из двух прочтений верно, не угадываю.
  if (command.kind === 'price' && command.alsoReadsAs) {
    const other = await findOwnedOffer(opts.partnerId, command.alsoReadsAs.title);
    if (other.outcome === 'db_error') return offerEditDbErrorText();
    if (other.outcome !== 'missing') {
      return offerEditSpacedPriceText(command.alsoReadsAs.title, command.alsoReadsAs.spacedPrice);
    }
  }
  const found = await findOwnedOffer(opts.partnerId, command.title);
  if (found.outcome === 'db_error') return offerEditDbErrorText();
  if (found.outcome === 'missing') return offerEditMissingText(parsed.command.title);
  if (found.outcome === 'ambiguous') return offerEditAmbiguousText(parsed.command.title, found.count);

  const saved = await savePendingOfferEdit({
    partnerId: opts.partnerId,
    offer: found.offer,
    priceRub: parsed.command.kind === 'price' ? parsed.command.priceRub : null,
    conditions: parsed.command.kind === 'conditions' ? parsed.command.conditions : null,
  });
  if (saved.outcome === 'db_error') return offerEditDbErrorText();
  if (saved.outcome === 'missing') return offerEditMissingText(parsed.command.title);
  if (saved.outcome === 'ambiguous') return offerEditAmbiguousText(parsed.command.title, saved.count);
  return offerEditSavedText({ ...saved, kind: parsed.command.kind });
}
