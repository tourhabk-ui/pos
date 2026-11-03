/**
 * «Подними всё на 10%», «наценка на выходные 15%» — K.ai B4.
 *
 * Без модели: процент — только из слов партнёра, цифры предпросмотра — из
 * движка счёта. Кузьмич цены НЕ ПИШЕТ: он кладёт изменение на сервер и даёт
 * ссылку; меняет цену подтверждение на сайте (вход, право цен, 24 часа,
 * одноразово — решение владельца 03.11). В тексте — только туры и цены,
 * личных данных нет.
 */
import { pool } from '@/lib/db-pool';
import { changeProblem, previewPriceChange, previewText, type PriceChange } from '@/lib/crm/price-preview';
import { confirmUrl, createPendingChange } from '@/lib/crm/price-change';

export type PhraseParse = { change: PriceChange } | { problem: string } | null;

const WEEKEND = /выходн|суббот|воскрес|(^|[^а-я])(сб|вс)([^а-я]|$)/;
const UP = /подним|подыми|повыс|увелич|накин|накрут|дороже|наценк|надбавк/;
const DOWN = /сниз|опуст|уменьш|пониз|дешевле/;
const REMOVE = /(убер|сним|отмен|выключ)[а-я]*\s+(\S+\s+)?(наценк|надбавк)/;
const PRICE = /цен|(^|[^а-я])все([^а-я]|$)|тур|прайс|наценк|надбавк/;

/** Разбор фразы. null — это не про изменение цены (пусть отвечает обычный путь). */
export function parsePriceChangePhrase(raw: string): PhraseParse {
  const t = raw.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  // Скидки на последние места и группу — свой экран; сюда не берём.
  if (/скидк/.test(t)) return null;
  if (REMOVE.test(t) && WEEKEND.test(t)) return { change: { kind: 'weekend_markup', percent: null, tourIds: 'all' } };
  const m = /(\d+(?:[.,]\d+)?)\s*(%|процент)/.exec(t);
  if (!m || !PRICE.test(t)) return null;
  const up = UP.test(t), down = DOWN.test(t);
  if (up === down) return null; // направление не названо или названы оба — не угадываем
  const n = Number(m[1].replace(',', '.'));
  const change: PriceChange = WEEKEND.test(t)
    ? { kind: 'weekend_markup', percent: n, tourIds: 'all' }
    : { kind: 'base_price', percent: up ? n : -n, tourIds: 'all' };
  if (WEEKEND.test(t) && down) return { problem: 'На выходные можно только наценку. Снизить цену в выходные — через скидку на экране «Скидки».' };
  const problem = changeProblem(change);
  return problem ? { problem } : { change };
}

/** Ответ на фразу или null — фраза не про цены. */
export async function handlePriceChangePhrase(opts: { partnerId: string; sellsTours: boolean; text: string; nowMs: number }): Promise<string | null> {
  if (!opts.sellsTours) return null;
  const parsed = parsePriceChangePhrase(opts.text);
  if (parsed === null) return null;
  if ('problem' in parsed) return `${parsed.problem}\nЦены не менял.`;
  try {
    const preview = await previewPriceChange(opts.partnerId, parsed.change, opts.nowMs);
    if (preview.tours.length === 0) return 'Понял так: изменить цены. Но туров для изменения не нашлось — цены не менял.';
    const id = await createPendingChange(pool, opts.partnerId, preview, opts.nowMs);
    return [
      `Понял так: ${previewText(preview)}`,
      '',
      'Я цены не меняю. Проверьте и подтвердите на сайте (нужен вход, ссылка одноразовая, действует 24 часа):',
      confirmUrl(id),
    ].join('\n');
  } catch (err) {
    console.error('[price-change-phrase] предпросмотр не собран:', err instanceof Error ? err.message : String(err));
    return 'Не смог посчитать новые цены — ничего не менял. Попробуйте ещё раз или на сайте, «Скидки и наценки».';
  }
}
