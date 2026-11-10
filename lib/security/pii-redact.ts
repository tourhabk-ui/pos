/**
 * Детерминированная чистка персональных данных из свободного текста ПЕРЕД
 * отправкой в зарубежные LLM (152-ФЗ: минимизируем трансграничную передачу ПД).
 *
 * Режет телефоны и email — структурно-детектируемые ПД. Имя туриста стоит
 * убирать отдельно (псевдонимизацией на уровне вызова), т.к. по тексту его
 * не отличить от обычных слов. Свободный текст (комментарий лида, сообщения
 * чата) может содержать телефон/почту, которые турист вписал сам, — их и чистим.
 *
 * Чистая функция — под тестом. НЕ трогает короткие числа (цены, даты, группы).
 */

/*
 * Телефон отличается от прочих чисел формой, а не одним счётом цифр.
 *
 * С аудита 15.10 (W2-5, ревью A20) через redactPII проходит каждая реплика
 * туриста перед моделью Кузьмича. Прежнее правило «10–15 цифр с разделителями,
 * точка тоже разделитель» превращало в [телефон] то, что модель обязана
 * видеть: даты поездки «10-15.08.2026», координаты «53.2551 158.8432»
 * (инструмент погоды берёт их из вопроса), бюджет «150 000 - 200 000». Отсюда
 * три различения:
 *  1. Число с точкой внутри (дата, дробь, координата) — целиком не телефон и
 *     не склеивается с соседями. Цена: телефон, записанный через точки
 *     («914.123.45.67»), не распознаётся — так его почти не пишут.
 *  2. Дефис с пробелом хотя бы с одной стороны — граница диапазона, а не
 *     разделитель внутри номера: каждую сторону судим отдельно.
 *  3. Два числа ОДНОЙ длины по возрастанию через один дефис без «+» —
 *     диапазон («150000-200000», «30000-50000»), а не номер. Длину сверяем
 *     нарочно: номер с одним дефисом делится на части разной длины
 *     («8914-1234567», «4152-412318»), и такой номер вырезается, как раньше.
 *     Цена — диапазон с частями разной длины («50000-150000») уйдёт модели
 *     как [телефон]: для чистки ПД лишнее вырезанное лучше пропущенного.
 *
 * 10.11 (ревью безопасности #3204): верхней границы «не больше 15 цифр» у
 * цепочки больше нет. Она судила всю цепочку цифр разом, и номер рядом с датой
 * или бюджетом — «+7… 10-14 2 дня», «8914… 10000 рублей» — давал 16 цифр и
 * уходил модели дословно. Теперь:
 *  4. Номер одним словом (10–15 цифр без пробелов внутри) вырезается сам, а
 *     соседние числа судятся отдельно: даты и бюджет рядом с ним остаются.
 *  5. Слова короче десяти цифр, стоящие подряд, — цепочка: номер, записанный
 *     с пробелами. От десяти цифр она вырезается целиком, сколько бы цифр в
 *     ней ни было. Цена: такой номер уносит с собой соседние числа («8 914
 *     123 45 67 10000»), и длинный ряд чисел без номера («150 000 200 000
 *     250 000») модель не увидит.
 *  6. Слово длиннее 15 цифр — не номер, а идентификатор (хвост UUID, номер
 *     записи): остаётся как есть, как и раньше, и в цепочку не входит.
 * Номер через косую черту («8/914/1234567») не распознаётся, как и через точки:
 * так пишут даты.
 *
 * 10.11, вторая правка (задача «утечка телефонов из планировщика»): проба на
 * main нашла две дыры и одну потерю.
 *  - Номер с дефисами через пробел («8 914 123 - 45 - 67») уходил модели
 *    дословно: правило 2 резало его на части короче десяти цифр.
 *  - Номер с длинным тире («123–45–67» — так его вставляют из заметок и с
 *    сайтов) не попадал в кандидаты вовсе: тире не было в списке знаков.
 *  - Правило 5 уносило с номером даты и бюджет рядом («+7 914 123-45-67 10-14
 *    августа» → «[телефон] августа»), и планировщик терял даты поездки.
 * Отсюда:
 *  7. Тире всех видов (‐ ‑ ‒ – — −) — то же, что дефис.
 *  8. Внутри цепочки номер вырезается по ФОРМЕ, а не по счёту: 11 цифр с
 *     7 или 8 впереди и кодом на 3, 4, 8, 9; 10 цифр с 3, 4, 8, 9 впереди; с
 *     «+» и другим кодом страны — 11–15 цифр. Сначала ищутся номера, начатые
 *     как номер («+7», «8», «(914)», «914»), потом остальные. Остаток цепочки
 *     судится правилом 5: от десяти цифр вырезается целиком — то, что на номер
 *     не похоже по форме, но цифр в нём на номер хватает, модель не увидит.
 *  9. Дефис с пробелом внутри номера допускается, если после него идут
 *     группы по две цифры («123 - 45 - 67»): так пишут номер и не пишут
 *     диапазон («30 000 - 50 000» остаётся диапазоном).
 */
/** Тире всех видов — как дефис (правило 7). */
const DASHES = '\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212';
const DOTTED_NUMBER = /(\d+(?:\.\d+)+)/;
const PHONE_CANDIDATE = new RegExp(`\\+?\\d[\\d\\s()${DASHES}]{8,}\\d`, 'g');
const RANGE_DASH = new RegExp(`(\\s+[${DASHES}]\\s*|\\s*[${DASHES}]\\s+)`);
const BARE_PAIR = new RegExp(`^(\\d{4,})[${DASHES}](\\d{4,})$`);
/** Слово, с которого номер начинают: «+7», «(914)», «8», «8(914)», «8-914», «914». */
const PHONE_START = new RegExp(`^(?:[+(]|[78](?:$|[(${DASHES}]))`);

const digitsOf = (s: string): string => s.replace(/\D/g, '');
const digitCount = (s: string): number => digitsOf(s).length;

/** «150000-200000»: два числа одной длины по возрастанию — диапазон, а не номер. */
function isBareRange(part: string): boolean {
  const pair = BARE_PAIR.exec(part);
  return pair !== null && pair[1].length === pair[2].length && Number(pair[1]) < Number(pair[2]);
}

/** Номер одним словом: «+79001234567», «8(900)123-45-67». */
function isPhoneWord(word: string): boolean {
  const digits = digitCount(word);
  return digits >= 10 && digits <= 15 && !isBareRange(word);
}

/**
 * Цифры D, набранные словами подряд, — номер по форме (правило 8)?
 * `plus` — первое слово начато с «+».
 */
function isPhoneShape(d: string, plus: boolean): boolean {
  if (/^[78][3489]/.test(d)) return d.length === 11;
  if (plus) return d.length >= 11 && d.length <= 15;
  return d.length === 10 && /^[3489]/.test(d);
}

interface Token {
  text: string;
  digits: string;
  word: boolean;
  /** Разделитель — дефис или тире с пробелом (правило 2). */
  range: boolean;
}

function tokenize(candidate: string): Token[] {
  const tokens: Token[] = [];
  candidate.split(RANGE_DASH).forEach((part, i) => {
    if (i % 2 !== 0) {
      tokens.push({ text: part, digits: '', word: false, range: true });
      return;
    }
    part.split(/(\s+)/).forEach((piece, j) => {
      if (piece === '') return;
      const word = j % 2 === 0;
      tokens.push({ text: piece, digits: word ? digitsOf(piece) : '', word, range: false });
    });
  });
  return tokens;
}

/**
 * Номер с пробелами внутри цепочки коротких слов (`run` — индексы слов в
 * `tokens`). Возвращает пары [первое, последнее] слово каждого вырезаемого
 * куска: сперва номера по форме (правило 8), потом остаток от десяти цифр
 * (правило 5). Дефис с пробелом разрывает остаток (правило 2), а номер по
 * форме переходит его только группами по две цифры (правило 9).
 */
function carveRun(tokens: Token[], run: number[]): Array<[number, number]> {
  const n = run.length;
  const carved = new Array<boolean>(n).fill(false);
  const spans: Array<[number, number]> = [];
  const rangeBefore = (k: number): boolean => {
    for (let t = run[k - 1] + 1; t < run[k]; t++) if (tokens[t].range) return true;
    return false;
  };

  const matchAt = (i: number): number => {
    const plus = tokens[run[i]].text.startsWith('+');
    let d = '';
    let crossed = false;
    for (let k = i; k < n; k++) {
      if (carved[k]) return -1;
      if (k > i && rangeBefore(k)) crossed = true;
      if (crossed && tokens[run[k]].digits.length !== 2) return -1;
      d += tokens[run[k]].digits;
      if (d.length > 15) return -1;
      if (isPhoneShape(d, plus)) return k;
    }
    return -1;
  };

  const pass = (startedOnly: boolean): void => {
    for (let i = 0; i < n; i++) {
      if (carved[i]) continue;
      const tok = tokens[run[i]];
      if (startedOnly && !PHONE_START.test(tok.text) && !/^9\d\d$/.test(tok.digits)) continue;
      const j = matchAt(i);
      if (j < 0) continue;
      for (let k = i; k <= j; k++) carved[k] = true;
      spans.push([run[i], run[j]]);
      i = j;
    }
  };
  pass(true);
  pass(false);

  // Остаток: куски подряд, не вырезанные по форме, разорванные дефисом с пробелом.
  let from = -1;
  let count = 0;
  const flush = (to: number): void => {
    if (from >= 0 && count >= 10) spans.push([run[from], run[to]]);
    from = -1;
    count = 0;
  };
  for (let k = 0; k < n; k++) {
    if (carved[k]) {
      flush(k - 1);
      continue;
    }
    if (from >= 0 && rangeBefore(k)) flush(k - 1);
    if (from < 0) from = k;
    count += tokens[run[k]].digits.length;
  }
  flush(n - 1);
  return spans;
}

function redactCandidate(candidate: string, label: (phone: string) => string): string {
  const tokens = tokenize(candidate);
  const spans: Array<[number, number]> = [];
  let run: number[] = [];
  const closeRun = (): void => {
    if (run.length > 0) spans.push(...carveRun(tokens, run));
    run = [];
  };
  tokens.forEach((tok, t) => {
    if (!tok.word) return;
    if (tok.digits.length >= 10) {
      // Слово от десяти цифр судится само (правила 4 и 6) и рвёт цепочку.
      closeRun();
      if (isPhoneWord(tok.text)) spans.push([t, t]);
    } else {
      run.push(t);
    }
  });
  closeRun();

  const startAt = new Map<number, number>(spans.map(([a, b]) => [a, b]));
  let out = '';
  for (let t = 0; t < tokens.length; t++) {
    const end = startAt.get(t);
    if (end === undefined) {
      out += tokens[t].text;
      continue;
    }
    out += label(tokens.slice(t, end + 1).map((x) => x.text).join(''));
    t = end;
  }
  return out;
}

function redactPhones(segment: string, keepTail: boolean): string {
  const label = (phone: string): string =>
    keepTail ? `[телефон …${digitsOf(phone).slice(-4)}]` : '[телефон]';
  return segment.replace(PHONE_CANDIDATE, (m) => redactCandidate(m, label));
}

export interface RedactOptions {
  /**
   * Оставить четыре последние цифры номера: «[телефон …4567]». Для помощника
   * кабинета партнёра — инструмент CRM ищет клиента по 4+ цифрам, а без хвоста
   * «найди клиента +7 914 …» молча не находил бы никого. По четырём цифрам
   * человека не узнать.
   */
  keepPhoneTail?: boolean;
}

/** Заменяет email и телефоны на нейтральные плейсхолдеры. */
export function redactPII(text: string | null | undefined, opts: RedactOptions = {}): string {
  if (!text) return '';
  let out = text;

  // Email
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');

  // Телефоны: от 10 цифр (опц. + в начале) с пробелами, скобками, дефисами.
  // Числа с точкой внутри — нечётные куски split — остаются как есть.
  out = out
    .split(DOTTED_NUMBER)
    .map((seg, i) => (i % 2 === 0 ? redactPhones(seg, opts.keepPhoneTail === true) : seg))
    .join('');

  return out;
}

/**
 * Реплики человека в разговоре — через redactPII; остальные роли как есть.
 *
 * Граница ПД перед зарубежной моделью для чата Кузьмича (аудит 15.10, W2-5):
 * до неё текст туриста уходил в модель как есть, а redactPII стоял только
 * перед веб-поиском. Чистится то, что написал человек (роль `user`):
 * системный промпт и выводы инструментов несут данные платформы — телефон
 * оператора, МЧС, 112, — и турист получает их от Кузьмича намеренно. Свой
 * телефон и почту в разговор вписывает только человек.
 *
 * Детерминированные шаги (бронь, контроль выхода) читают сырой текст ДО этой
 * границы: им телефон нужен, и модели они его не передают.
 */
export function redactUserTurns<T extends { role: string; content: string }>(turns: readonly T[]): T[] {
  return turns.map((m) => (m.role === 'user' ? { ...m, content: redactPII(m.content) } : m));
}

/** Есть ли в тексте детектируемые ПД (телефон/email). */
export function hasPII(text: string | null | undefined): boolean {
  if (!text) return false;
  return redactPII(text) !== text;
}

/**
 * Маска ПД для текста, уходящего в Telegram партнёру (разбор 03.11, п.6):
 * сверх телефона и почты — ссылки на профили (vk, t.me, instagram и любые
 * адреса), @ники, имя, которым человек представился («меня зовут Анна»,
 * «это Иван», подпись «— Мария»), и известные имена отправителя (`names`).
 * Имя вне этих оборотов не угадывается: любое слово с большой буквы — это и
 * «Камчатка», и «Авачинский».
 */
export function redactChatPD(text: string | null | undefined, names: ReadonlyArray<string | null | undefined> = []): string {
  if (!text) return '';
  let out = text;
  // Ссылки: со схемой и голые домены соцсетей.
  out = out.replace(/\bhttps?:\/\/\S+/gi, '[ссылка]');
  out = out.replace(/\b(?:www\.)?(?:vk\.com|vk\.ru|m\.vk\.com|t\.me|telegram\.me|instagram\.com|ok\.ru|wa\.me|max\.ru)\/\S+/gi, '[ссылка]');
  // Почта — раньше ников: «a@b.ru» не должен стать «a[ник]».
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/(^|[^\w@])@[A-Za-z0-9_]{3,32}\b/g, '$1[ник]');
  // Представился: «меня зовут Анна», «я — Иван Петров», «это Мария», «my name is John».
  const NAME = '[А-ЯЁA-Z][а-яёa-z]+(?:[ -][А-ЯЁA-Z][а-яёa-z]+){0,2}';
  out = out.replace(new RegExp(`([Мм]еня\\s+зовут|[Мм]о[её]\\s+имя|[Mm]y\\s+name\\s+is)(\\s*[—–-]?\\s*)(${NAME})`, 'gu'), '$1$2[имя]');
  // «Это Иван.», «Я — Мария,»: только если за именем конец фразы — иначе «это Авачинский вулкан».
  out = out.replace(new RegExp(`((?:^|[\\s,.!])(?:[Ээ]то|[Яя]|I'm|I\\s+am))(\\s*[—–-]?\\s*)(${NAME})(?=\\s*(?:[.,!;\\n)]|$))`, 'gu'), '$1$2[имя]');
  // Подпись в конце: «— Мария», «С уважением, Иван».
  out = out.replace(new RegExp(`(с\\s+уважением,?\\s*|спасибо,?\\s*|^|\\n)([—–-]\\s*)?(${NAME})\\s*$`, 'iu'), (m, pre: string, dash: string | undefined, name: string) =>
    (pre && /уважением|спасибо/i.test(pre)) || dash ? `${pre}${dash ?? ''}[имя]` : m);
  for (const n of names) {
    const t = n?.trim();
    if (!t || t.length < 2) continue;
    for (const part of [t, ...t.split(/\s+/).filter((w) => w.length >= 3)]) {
      const esc = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Без lookbehind: модуль идёт в клиентский бандл (Safari < 16.4).
      out = out.replace(new RegExp(`(^|[^\\p{L}])${esc}(?![\\p{L}])`, 'giu'), '$1[имя]');
    }
  }
  return redactPII(out);
}
