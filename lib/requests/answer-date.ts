/**
 * lib/requests/answer-date.ts — на какую дату заявки дан ответ оператора
 * (план «после отказа», этап 2а, миграция 1422).
 *
 * Ответ кнопкой (`partner_incoming_answers`) хранит дату заявки, на которую
 * дан (`subject_date`). Одно выражение даты — на запись ответа, на JOIN
 * статуса заявки, на «Изменить дату» и на передачу большой группы: если они
 * читали бы дату по-разному, ответ на 15.01 показался бы ответом на 20.01.
 *
 * Только строгий ISO: `source_data.date` — jsonb, у заявок с формы там может
 * лежать что угодно; не-ISO — «даты нет» (NULL), а не 22008 на весь запрос.
 *
 * Дата в кнопке «Да» и в кнопках причин отказа (`answerDayCode`) — номер дня
 * в base36: оператор открыл вопрос о 15.01, турист перенёс на 20.01 — нажатие
 * «Да» не запишет «нет мест» на дату, которую оператор не видел. Без базы.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Код «у заявки даты нет». */
const NO_DATE = 'x';

/** Дата заявки в ISO или NULL. `alias` — псевдоним таблицы `leads` в запросе. */
export function LEAD_ANSWER_DATE_SQL(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('LEAD_ANSWER_DATE_SQL: псевдоним таблицы — только буквы, цифры и _');
  return `(CASE WHEN ${alias}.source_data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ${alias}.source_data->>'date' END)`;
}

/**
 * ISO-дата → короткий код для кнопки; null — `x`. Код только у даты, которая
 * возвращается из него той же строкой: «2027-02-30» проходит регулярку
 * (LEAD_ANSWER_DATE_SQL), но Date.UTC сдвинул бы её на 02.03 — и «Да» с 02.03
 * никогда не совпало бы с датой заявки. Такая дата (и дата до 1970) — null:
 * кнопку строят без хвоста, а запись идёт без сверки даты.
 */
export function answerDayCode(date: string | null): string | null {
  if (date === null) return NO_DATE;
  const m = ISO_DAY.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || ms < 0) return null;
  const code = Math.round(ms / DAY_MS).toString(36);
  return answerDayOf(code) === date ? code : null;
}

/** Дату можно положить в кнопку и сверить при нажатии (см. answerDayCode). */
export function answerDateCodable(date: string | null): boolean {
  return answerDayCode(date) !== null;
}

/** Код из кнопки → ISO-дата; `x` — null; не код — undefined. */
export function answerDayOf(code: string): string | null | undefined {
  if (code === NO_DATE) return null;
  if (!/^[0-9a-z]{1,4}$/.test(code)) return undefined;
  const day = parseInt(code, 36);
  if (!Number.isFinite(day)) return undefined;
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** ДД.ММ.ГГГГ для человека; не ISO — как есть. */
export function ruAnswerDate(date: string): string {
  const m = ISO_DAY.exec(date);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : date;
}
