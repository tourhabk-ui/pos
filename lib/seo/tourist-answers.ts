/**
 * Короткие ответы туристу для llms.txt (разбор видимости Ведара в ответах ИИ,
 * 19.11): «сколько стоит» и «когда ехать» — числа из туров витрины тем же
 * правилом, что FAQ посадочных (lib/seo/query-landing-faq); правила
 * заповедника и МЧС — те же формулировки с источником (lib/seo/query-landings).
 */
import { plural } from '@/lib/home/data-freshness';
import { busiestMonthsWords, monthsWords, priceRangesWords, seasonCover } from '@/lib/seo/query-landing-faq';
import { KRONOKI_ESCORT, RU_MCHS_FAQ } from '@/lib/seo/query-landings';

export type AnswerTour = { base_price: string; price_unit: string | null; season_start: string | null; season_end: string | null };

/**
 * Раздел «Короткие ответы туристу». Туров не прочиталось или нет — вопросов о
 * цене и сезоне нет: ответа из базы тогда нет, а выдумывать его нельзя (§4.0).
 */
export function touristAnswersRu(tours: readonly AnswerTour[], BASE: string): string {
  const lines = ['', '## Короткие ответы туристу (посчитано по базе Ведара при выдаче этого файла)', ''];
  if (tours.length > 0) {
    const prices = priceRangesWords(tours, 'ru');
    if (prices) {
      const rest = prices.rest > 0 ? ` У ${prices.rest} ${plural(prices.rest, 'тура', 'туров', 'туров')} цена записана иначе или не записана.` : '';
      lines.push(`- **Сколько стоит тур на Камчатку?** В каталоге ${tours.length} ${plural(tours.length, 'тур', 'тура', 'туров')} местных операторов: ${prices.text}. Это цены, которые операторы указали на Ведаре; итог называет оператор при подтверждении заявки.${rest} Подробно — [каталог](${BASE}/catalog), по темам — [Долина гейзеров](${BASE}/dolina-gejzerov-ekskursiya), [Курильское озеро](${BASE}/kurilskoe-ozero-tury), [рыбалка](${BASE}/rybalka-na-kamchatke-tury), [вертолётные экскурсии](${BASE}/vertoletnye-ekskursii-kamchatka).`);
    }
    const cover = seasonCover(tours);
    const busiest = busiestMonthsWords(cover.months);
    if (busiest) {
      const unknown = cover.unknown > 0 ? ` У ${cover.unknown} ${plural(cover.unknown, 'тура', 'туров', 'туров')} сезон не записан.` : '';
      lines.push(`- **Когда ехать на Камчатку?** По данным операторов туры идут: ${monthsWords([...cover.months.keys()], 'ru')}. Больше всего туров в месяце: ${busiest}.${unknown} Сезон своего тура — в его карточке.`);
    }
  }
  lines.push(`- **Можно ли самостоятельно в Долину гейзеров или на Курильское озеро?** ${KRONOKI_ESCORT}.`);
  lines.push(`- **${RU_MCHS_FAQ.q}** ${RU_MCHS_FAQ.a.replace('форма Ведара /register', `форма Ведара ${BASE}/register`)}`);
  lines.push(`- **Сколько стоит перелёт?** Цен на билеты у Ведара нет — их называют авиакомпании и сервисы продажи билетов.`);
  return lines.join('\n');
}
