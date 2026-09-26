/**
 * Стиль поездки и дни отдыха из слов человека — без модели.
 *
 * Быстрый путь формы («Опишите поездку») понимает, КУДА и КОГДА. Стиль
 * («сам», «с гидом», «с оператором») и отдых («два дня отдыха») разбираются
 * здесь детерминированно: модели эти слова не нужны, а ошибка парсера в
 * сторону «сам» стоила бы человеку похода без гида. Поэтому правило узкое:
 * не уверены — `null`, и форма остаётся с выбором по умолчанию, который
 * человек видит на шаге 3.
 *
 * Модуль чистый, без импортов: его читает и клиент, и роут.
 */

export interface ParsedTravelPreferences {
  travelStyle: 'self' | 'operator' | 'mixed' | null;
  restDays: number | null;
}

const OPERATOR_WORDS = /(с\s+гид(ом|ами)?|с\s+оператор(ом|ами)?|организованн\S*|в\s+группе\s+с\s+гидом|туры?\s+под\s+ключ)/i;
const SELF_WORDS = /(^|[^а-яё])(сам|сама|сами|самостоятельн\S*|без\s+гида|без\s+оператор\S*|дикар\S*)([^а-яё]|$)/i;
const MIXED_WORDS = /(вперемешку|и\s+сам\S*\s+и\s+с\s+(гидом|оператором)|частично\s+с\s+гидом)/i;

const NUMBER_WORDS: Record<string, number> = {
  'один': 1, 'одного': 1, 'одним': 1,
  'два': 2, 'двух': 2, 'пару': 2, 'пара': 2,
  'три': 3, 'трёх': 3, 'трех': 3,
  'четыре': 4, 'четырёх': 4, 'четырех': 4,
  'пять': 5, 'пяти': 5,
};

/** «2 дня отдыха», «два дня на отдых», «день отдыха», «отдых 3 дня». */
function parseRestDays(text: string): number | null {
  const t = text.toLowerCase();
  const before = t.match(/(\d{1,2}|[а-яё]+)\s+(дн[ейяь]+|день)\s+(на\s+)?отдых/);
  const after = t.match(/отдых[а-яё]*\s+(\d{1,2}|[а-яё]+)\s+(дн[ейяь]+|день)/);
  const single = /(^|[^а-яё])день\s+(на\s+)?отдых/.test(t);
  const raw = before?.[1] ?? after?.[1] ?? null;
  if (raw) {
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (Number.isInteger(n) && n >= 0 && n <= 14) return n;
  }
  if (single) return 1;
  if (/без\s+(дней\s+)?отдыха/.test(t)) return 0;
  return null;
}

export function parseTravelPreferences(text: string): ParsedTravelPreferences {
  const t = text.toLowerCase();
  let travelStyle: ParsedTravelPreferences['travelStyle'] = null;
  if (MIXED_WORDS.test(t)) travelStyle = 'mixed';
  else {
    const op = OPERATOR_WORDS.test(t);
    const self = SELF_WORDS.test(t);
    // Оба сразу («сам, но на вулкан с гидом») — это и есть вперемешку.
    if (op && self) travelStyle = 'mixed';
    else if (op) travelStyle = 'operator';
    else if (self) travelStyle = 'self';
  }
  return { travelStyle, restDays: parseRestDays(t) };
}
