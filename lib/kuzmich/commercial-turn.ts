/**
 * Живой ход коммерческого ответа: читает витрины и отдаёт текст
 * `composeCommercial`. Сайт, Telegram и MAX зовут эту функцию,
 * чтобы список и цена не расходились с карточками.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { loadStayFacts } from '@/lib/kuzmich/accommodation-search';
import { composeCommercial, type CommercialSurface, type TransferItem } from '@/lib/kuzmich/answer-quality';
import { RENTAL_SITE_PAUSE, rentalSitePauseActive } from '@/lib/rental/site-pause';
import { loadShowcaseTours } from '@/lib/telegram/tourist-tours';
import { carrierPagePath, CHARTER_REQUEST_ANCHOR, rateWords } from '@/lib/transfers/charter-format';
import { loadCharterCarriers, type CharterCarrier } from '@/lib/transfers/charter';

function transferItems(carriers: CharterCarrier[], base: string): TransferItem[] {
  return carriers.map((carrier) => {
    const lines = [
      ...carrier.destinations.map((d) => `${d.from ? `${d.from} — ` : ''}${d.to} ${d.priceRub} руб за машину`),
      ...carrier.rates.map((rate) => rateWords(rate, carrier.rates)),
    ];
    return {
      slug: carrier.slug,
      name: carrier.name,
      lines,
      url: `${base}${carrierPagePath(carrier.slug)}#${CHARTER_REQUEST_ANCHOR}`,
    };
  });
}

function needsTours(question: string): boolean {
  return /тур|вулкан|рыбалк|восхожд|поход|экскурс/i.test(question);
}

function needsTransfers(question: string): boolean {
  return /трансфер|аэропорт/i.test(question);
}

function needsStays(question: string): boolean {
  return /остановиться|жиль|отел|гостиниц|ноч/i.test(question);
}

function stayZone(question: string): string | null {
  const t = question.toLowerCase().replace(/ё/g, 'е');
  if (t.includes('паратунк')) return 'паратунк';
  return null;
}

/**
 * null — вопрос не про тур, трансфер, жильё, прокат и не про цену прошлого списка.
 * Тогда отвечает модель.
 */
export async function resolveCommercialTurn(
  question: string,
  opts: { history: string; surface: CommercialSurface; now?: Date },
): Promise<{ visible: string; tours: import('@/lib/telegram/tourist-tours').CatalogTour[] } | null> {
  const now = opts.now ?? new Date();
  const base = getPublicBaseUrl();
  const pauseActive = rentalSitePauseActive(now);
  const [tours, transfers, stays] = await Promise.all([
    needsTours(question)
      ? loadShowcaseTours(question).catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        console.error('[commercial-turn] туры', code ? `SQLSTATE ${code}` : (err instanceof Error ? err.message.slice(0, 200) : 'нет SQLSTATE'));
        return { ok: false as const };
      })
      : Promise.resolve({ ok: true as const, tours: [] }),
    needsTransfers(question)
      ? loadCharterCarriers().then(
        (carriers) => ({ ok: true as const, items: transferItems(carriers, base) }),
        (err: unknown) => {
          const code = (err as { code?: string } | null)?.code;
          console.error('[commercial-turn] трансфер', code ? `SQLSTATE ${code}` : (err instanceof Error ? err.message.slice(0, 200) : 'нет SQLSTATE'));
          return { ok: false as const };
        },
      )
      : Promise.resolve({ ok: true as const, items: [] }),
    needsStays(question)
      ? loadStayFacts(stayZone(question))
      : Promise.resolve({ ok: true as const, items: [] }),
  ]);
  const composed = composeCommercial({
    question,
    history: opts.history,
    now,
    surface: opts.surface,
    base,
    pauseActive,
    pauseSlugs: RENTAL_SITE_PAUSE.slugs,
    tours,
    transfers,
    stays,
  });
  if (!composed) return null;
  return composed;
}
