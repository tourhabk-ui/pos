/**
 * lib/kuzmich/yes-no.ts — «да» и «нет» в чате Кузьмича: шаги брони в MAX и
 * ответ на сводку отложенной заявки (#3399, п. 4). Лёгкий модуль: его зовёт
 * и веб-чат, которому весь core не нужен.
 */
const YES = ['да', 'yes', 'верно', 'подтверждаю', 'всё верно', 'ок', 'окей', 'ok', 'го', 'давай', 'подтвердить'];
const NO = ['нет', 'no', 'не верно', 'отмена', 'cancel', 'стоп', 'stop', 'отменить', 'назад'];

// Слово целиком, не подстрока (проверка качества 24.10): на шаге «Всё верно?»
// «У нас беда», «вода прибывает», «когда нас найдут?» несли в себе «да» и
// отправляли заявку оператору вместе с ПД; «интернет» нёс «нет».
// Левая граница — захватом префикса, а не lookbehind: модуль едет в браузер
// (кнопки «Остановить»/«Ещё раз», #3412), а Safari до 16.4 lookbehind не
// разбирает и роняет модуль при загрузке (client-regex-no-lookbehind).
const wholeWord = (words: readonly string[]) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'u');
const YES_RE = wholeWord(YES);
const NO_RE = wholeWord(NO);

export function isYes(t: string) { return YES_RE.test(t.toLowerCase()); }
export function isNo(t: string)  { return NO_RE.test(t.toLowerCase()); }
