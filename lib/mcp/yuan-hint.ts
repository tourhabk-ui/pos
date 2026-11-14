/**
 * Юани рядом с рублями в ответе MCP китайскому клиенту (владелец 14.11:
 * «если запрос из Китая, то пересчитывать по курсу ЦБ»).
 *
 * Курс ЦБ уже показывался на китайских страницах /zh (lib/currency/cbr-rate,
 * карт-бланш 29.10), а ответ агенту давал одни рубли: китайская модель
 * пересчитывала сама, по курсу из своей памяти или не пересчитывала вовсе.
 *
 * «Запрос из Китая» — то, что мы видим, а не страна по адресу: адрес не
 * читается и не хранится (152-ФЗ). Признаков два:
 *   - вопрос иероглифами (lib/mcp/query-lang, `zh`);
 *   - клиент из экосистемы КНР по самоназванию (lib/mcp/china-clients:
 *     Qwen Code, Kimi, Doubao, Dify…).
 *
 * Пересчёт — подсказка, а не цена: рубли остаются, рядом «约 N 元», в конце —
 * курс, его дата и источник. Курс не прочитался — рубли как есть и строка
 * «курс не прочитан», а не выдуманный курс (§4.0).
 *
 * Сторож: tests/unit/mcp-yuan-hint.test.ts.
 */
import { approxYuan, type CbrRate } from '@/lib/currency/cbr-rate';
import { clientRegion, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';
import type { QueryLang } from '@/lib/mcp/query-lang';

/** Нужен ли пересчёт: вопрос по-китайски или клиент из КНР. */
export function wantsYuan(lang: QueryLang, userAgent: string): boolean {
  return lang === 'zh' || clientRegion(userAgent) === CHINA_REGION_LABEL;
}

/**
 * Сумма в рублях, как её пишут инструменты: «15 000 ₽», «320 000 ₽/чел.»,
 * «1 500–5 000 ₽». Разделитель разрядов — пробел, неразрывный или узкий.
 * Единица после рубля («/чел.», «/день») остаётся при сумме, юани — после неё.
 */
const RUB_AMOUNT = /(\d{1,3}(?:[   ]\d{3})+|\d+)(\s?₽)(\/[а-яё.]+)?/gu;

function rubNumber(s: string): number {
  return Number(s.replace(/[   ]/g, ''));
}

/** Строка курса в конце ответа — по-китайски и по-английски. */
export function yuanRateNote(rate: CbrRate | null): string {
  if (!rate) {
    return '\n\n[价格以卢布计价；俄罗斯央行汇率暂未读取，未换算人民币。Prices are in rubles; the Bank of Russia CNY rate could not be read, so no yuan estimate is given.]';
  }
  const [d, m, y] = rate.date.split('.');
  const perUnit = rate.rubPerUnit.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `\n\n[人民币为估算：1 元 = ${perUnit} 卢布，俄罗斯央行 ${y}-${m}-${d} 汇率（cbr.ru）。价格以卢布计价，向旅行社以卢布支付。Yuan amounts are estimates at the Bank of Russia rate of ${rate.date}: 1 CNY = ${perUnit} RUB. Prices are set and paid in rubles.]`;
}

/**
 * Дописать «约 N 元» к каждой рублёвой сумме и строку курса в конец.
 * В ответе нет рублей — ответ не меняется: курс без цен — лишний шум.
 */
export function withYuan(text: string, rate: CbrRate | null): string {
  if (!/₽/.test(text)) return text;
  if (!rate) return text + yuanRateNote(null);
  const converted = text.replace(RUB_AMOUNT, (whole, num: string) => {
    const yuan = approxYuan(rubNumber(num), rate);
    return yuan ? `${whole} (${yuan})` : whole;
  });
  return converted + yuanRateNote(rate);
}
