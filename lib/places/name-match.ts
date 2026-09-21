/**
 * Совпадение имени места без учёта порядка слов (issue #1987, #1986).
 *
 * `name ILIKE '%Мутновский вулкан%'` — это ОДНА строка-подстрока: порядок
 * слов в ней буквальный. Каталог называет вулканы «Вулкан Мутновский»
 * (тип первым, §4.1), а человек чаще спрашивает «Мутновский вулкан» (имя
 * первым) — и такой запрос не находит совпадения вовсе: «Вулкан Мутновский»
 * не содержит подстроки «Мутновский вулкан». Хуже того, случайная запись,
 * которая ЕЁ содержит («Скитур на Мутновский вулкан»), выигрывает у
 * канонической молча — турист получает ответ про другое место без единого
 * намёка, что оно другое (и без KVERT-строки, которая есть только у
 * канонической точки).
 *
 * Решение — сравнивать по СЛОВАМ: место подходит, если содержит все
 * значимые слова запроса, в любом порядке. Это не подмена `gradeNameMatch`
 * (тот судит НАЙДЕННУЮ строку на доверие), а починка более раннего шага —
 * какие строки вообще попадают в кандидаты из SQL.
 */

/** Короче — «на», «у», предлоги — не различают ничего. */
const MIN_WORD_LEN = 3;

/** Значимые слова запроса для сравнения без учёта порядка. */
export function significantWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= MIN_WORD_LEN);
}

/**
 * SQL-условие «колонка содержит все слова запроса, в любом порядке» +
 * параметры для него, начиная с плейсхолдера `$paramOffset`.
 *
 * Пустой список слов — вызывающий обязан сам отступить на буквальную
 * подстроку (короткая аббревиатура вроде «оз.» не даст значимых слов).
 */
export function nameContainsAllWordsSql(
  column: string,
  words: string[],
  paramOffset: number,
): { clause: string; params: string[] } {
  return {
    clause: words.map((_, i) => `${column} ILIKE $${paramOffset + i}`).join(' AND '),
    params: words.map((w) => `%${w}%`),
  };
}

/**
 * Та же проверка в чистом JS — для тестов и для мест, где заранее известна
 * строка кандидата (не идёт через SQL). Семантика идентична `ILIKE '%w%'`
 * для слов без `%`/`_` (а `significantWords` их и не производит).
 */
export function nameMatchesWords(candidate: string, words: string[]): boolean {
  const c = candidate.toLowerCase();
  return words.every((w) => c.includes(w));
}

/**
 * Готовое условие + параметры для запроса «имя ИЛИ псевдоним» места по
 * запросу пользователя. При отсутствии значимых слов — честный откат на
 * буквальную подстроку целиком, а не пустое условие (которое совпало бы
 * ce всем).
 */
export function placeNameSearchSql(
  column: string,
  rawQuery: string,
  paramOffset: number,
): { clause: string; params: string[] } {
  const words = significantWords(rawQuery);
  if (words.length === 0) {
    return { clause: `${column} ILIKE $${paramOffset}`, params: [`%${rawQuery}%`] };
  }
  return nameContainsAllWordsSql(column, words, paramOffset);
}
