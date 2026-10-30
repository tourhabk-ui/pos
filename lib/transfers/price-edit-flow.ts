/**
 * «цена …» в чате перевозчика (#2862 этап C). Модель фразу не видит: цену
 * она выдумывала, когда инструмента не было (урок проката).
 *
 * Черновик не меняет живую строку. Не перевозчик, пилот проката (у него
 * свой путь — lib/rental/offer-edit-flow) и обычный разговор — null,
 * помощник отвечает как раньше.
 */

import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  charterPriceAmbiguousText, charterPriceDbErrorText, charterPriceFormatHint, charterPriceMissingText,
  charterPriceNoRateText, charterPriceRejectText, charterPriceSavedText, charterPriceSpacedText,
  isCharterPriceEditAsk, parseCharterPriceEdit, priceRowLabel,
} from '@/lib/transfers/price-edit';
import { findOwnPriceRow, savePricePatch } from '@/lib/transfers/price-edit-store';

export async function handleCharterPriceEdit(opts: {
  partnerId: string;
  category: string;
  slug: string | null;
  text: string;
}): Promise<string | null> {
  if (opts.category !== 'transfer' || isRentalPilotSlug(opts.slug)) return null;
  if (!isCharterPriceEditAsk(opts.text)) return null;
  const parsed = parseCharterPriceEdit(opts.text);
  if (!parsed.ok) {
    return parsed.reason === 'format' || parsed.reason === 'not_edit'
      ? charterPriceFormatHint()
      : charterPriceRejectText(parsed);
  }
  const { command } = parsed;

  // «Горелый 8 500»: направление «Горелый» в прайсе есть — значит, это цена
  // с пробелом, а не направление «Горелый 8». Какое прочтение верно, не угадываю.
  if (command.target.kind === 'destination' && command.alsoReadsAs) {
    const other = await findOwnPriceRow(opts.partnerId, { kind: 'destination', words: command.alsoReadsAs.words });
    if (other.outcome === 'db_error') return charterPriceDbErrorText();
    if (other.outcome !== 'missing') return charterPriceSpacedText(command.alsoReadsAs.words, command.alsoReadsAs.spacedPrice);
  }

  const found = await findOwnPriceRow(opts.partnerId, command.target);
  if (found.outcome === 'db_error') return charterPriceDbErrorText();
  if (found.outcome === 'missing') {
    if (command.target.kind === 'destination') return charterPriceMissingText(command.target.words);
    return charterPriceNoRateText(command.target.kind === 'rate' ? command.target.unit : 'extra_day');
  }
  if (found.outcome === 'ambiguous') {
    const words = command.target.kind === 'destination' ? command.target.words : opts.text.trim();
    return charterPriceAmbiguousText(words, found.rows.map(priceRowLabel));
  }

  const saved = await savePricePatch({
    partnerId: opts.partnerId,
    row: found.row,
    patch: { priceRub: command.priceRub, priceNote: null, conditions: null, isActive: null },
  });
  if (saved.outcome !== 'saved') return charterPriceDbErrorText();
  return charterPriceSavedText({
    label: saved.saved.label,
    livePrice: found.row.priceRub,
    draftPrice: saved.saved.draft.priceRub ?? command.priceRub,
    live: found.row.isActive,
  });
}
