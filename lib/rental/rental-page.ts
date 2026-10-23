/**
 * Данные страницы прокатчика /car-rental/[slug] (витрина проката 23.10, по
 * образцу страницы перевозчика §14).
 *
 * Прокатчик — одна часть с тремя исходами: нашли / такого нет (404) / не
 * смогли проверить (исключение — страница падает в ошибку, а не рисует
 * «прокатчика нет»). Условия проката, реквизиты и признак «также
 * перевозчик» читаются тем же запросом (lib/rental/rental): отдельных
 * второстепенных частей, чей отказ надо глушить, у этой страницы пока нет —
 * нет отзывов и нет направлений с опасностями мест. Появятся — каждая получит
 * свои три исхода, как у перевозчика.
 */

import { loadRentalCompanyBySlug } from '@/lib/rental/rental';
import type { RentalCompanyProfile } from '@/lib/rental/rental-format';

export interface RentalPageData {
  company: RentalCompanyProfile;
}

/** null — такого прокатчика нет; отказ чтения — исключение. */
export async function loadRentalPage(slug: string): Promise<RentalPageData | null> {
  const company = await loadRentalCompanyBySlug(slug);
  if (!company) return null;
  return { company };
}
