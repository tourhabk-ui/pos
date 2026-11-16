/**
 * Сторож ПД на стоках вне модели: хранилище браузера, логи, Telegram, адрес.
 *
 * D1 (`pii-flow-scanner`) держит один сток — промпт зарубежной модели — и
 * держит его глубоко: поток через переменные, функции и файлы. Остальные
 * дороги, которыми имя и телефон человека уходили не туда, сторожа не имели,
 * и каждую находку ревью чинили отдельным PR (разбор 16.11, слово владельца
 * «Делай сторож»):
 *
 *   - хранилище браузера — черновик анкеты планера пережил «Выйти» (#3425,
 *     правка #3452); `OrdersContext` объявляет заказ с именем, почтой и
 *     телефоном клиента в localStorage;
 *   - открытый лог — вопросы туристов печатались в лог GitHub Actions
 *     публичного репозитория (#3203);
 *   - Telegram — имя и телефон каждого лида уходили на api.telegram.org, хотя
 *     ПД ходят только в MAX (решение владельца 23.08, `sendPdAlert`);
 *   - адрес — телефон в строке запроса остаётся в логах сервера, истории
 *     браузера и заголовке Referer.
 *
 * Что считается ПД — тот же словарь, что у D1 (`REDACTABLE_WORD`,
 * `IDENT_WORD`, `PERSONAL_NAME_FIELD`, `PERSONAL_OWNER_NAME`): второй ответ на
 * вопрос «что здесь персональные данные» разошёлся бы с первым молча.
 *
 * Правило намеренно узкое: в аргументе стока — прямое обращение к полю ПД
 * (`lead.phone`, `booking.customer_name`) или переменная с таким именем
 * (`touristPhone`, `email`). Поток через переменные с другими именами здесь не
 * прослеживается — это делает D1 для своего стока, и это добивает ревью.
 * Проверка наличия (`!!lead.phone`, `phone ? 'да' : 'нет'`, `email.length`)
 * находкой не считается: в лог уходит «есть/нет», а не сам номер.
 *
 * Чистые функции, без ФС: файл и текст на входе, находки на выходе. Обход
 * репозитория и реестры — `pd-sinks-registry.ts`.
 */

import { maskCode, snakeId, REDACTABLE_WORD, IDENT_WORD, PERSONAL_NAME_FIELD, PERSONAL_OWNER_NAME } from './pii-flow-scanner';

export type SinkKind = 'storage' | 'log' | 'telegram' | 'url';

export interface SinkFinding {
  file: string;
  line: number;
  kind: SinkKind;
  /** Сток словами: `localStorage.setItem`, `console.log`, `tgSend`, `адрес ?phone=`. */
  sink: string;
  /** Что ушло: `lead.phone`, `touristName`. */
  expr: string;
  pd: 'contact' | 'name';
}

/**
 * Функции, после которых ПД в аргументе не остаётся. Список явный: каждое имя
 * проверено по своему телу (маска или хэш), а шаблон `mask*` взял бы и
 * `maskCode` (маска кода, а не ПД). Новая чистка вносится сюда с тем, что она
 * делает с номером.
 */
export const PD_SANITIZERS: ReadonlySet<string> = new Set([
  'redactPII', // lib/security/pii-redact: телефоны и почта → плейсхолдеры
  'redactChatPD', // маска переписки: контакты, ники, имя клиента
  'redactUserTurns', // redactPII по репликам человека
  'redactPhones',
  'maskPhone', // оставляет хвост номера
  'maskPII',
  'maskChatText',
  'maskConvText',
  'maskClientName',
]);

const REDACTABLE_NAMED = new RegExp(`^(?:[a-z0-9$]+_)*(?:${REDACTABLE_WORD})s?$`, 'i');
const IDENT_NAMED = new RegExp(`^(?:[a-z0-9$]+_)*(?:${IDENT_WORD})s?$`, 'i');
const PERSON_NAME = new RegExp(`^${PERSONAL_NAME_FIELD.source.replace(/\\b/g, '')}$`, 'i');

/**
 * Слова словаря D1, которые на этих стоках — не ПД человека:
 *  - `chat_id` — адрес получателя в Telegram и MAX: без него сообщение не
 *    отправить, и в логе он нужен, чтобы найти недошедшее;
 *  - `address` — у места, гостиницы и сервера (`ip_address` — да, ПД, но
 *    отдельным словом ниже);
 *  - `inn` — ИНН компании-партнёра печатается в реквизитах на витрине;
 *  - `contact`/`contacts` — объект контактов КОМПАНИИ (`partners.contacts`).
 * Телефон и почта человека этим не прощаются: они ловятся своими словами.
 */
const NOT_PD_HERE = /^(?:[a-z0-9$]+_)*(?:chat_id|address|inn|contacts?|telegram)$/i;
/** Но из «адресов» — IP человека. */
const IP_ADDRESS = /^(?:[a-z0-9$]+_)*ip_address$/i;
/**
 * Служебные контакты, а не человек: телефон МЧС маршрута (§10), почта и
 * телефон платформы, получатель тестового письма МЧС.
 */
const SERVICE_CONTACT = /^(?:mchs|support|platform|admin|service|sender|from|reply_to|smtp|noreply|bot|owner_alert)_(?:phone|email|tel)$/i;

/** Род ПД идентификатора или поля — или null. */
export function pdKindOf(id: string): 'contact' | 'name' | null {
  const s = snakeId(id);
  if (SERVICE_CONTACT.test(s)) return null;
  if (IP_ADDRESS.test(s)) return 'contact';
  if (NOT_PD_HERE.test(s)) return null;
  if (REDACTABLE_NAMED.test(s) || IDENT_NAMED.test(s)) return 'contact';
  if (PERSON_NAME.test(s)) return 'name';
  return null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;

/** Конец скобки, открытой на `open` (по маске кода: строки затёрты). */
export function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** Отрезки аргументов вызовов-чисток внутри [from, to). */
function sanitizedRanges(code: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    if (!PD_SANITIZERS.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    out.push([open, closeOf(code, open)]);
  }
  return out;
}

const skipWs = (code: string, i: number): number => { while (i < code.length && /\s/.test(code[i])) i++; return i; };
const backWs = (code: string, i: number): number => { while (i > 0 && /\s/.test(code[i - 1])) i--; return i; };

/**
 * Проверка наличия, а не значение: `!!x.phone`, `!x.phone`, `typeof phone`,
 * `Boolean(phone)`, `phone.length`, `phone ? … : …`, `phone === null`,
 * `phone != null`, `phone && …` в условии не отличить — он остаётся находкой.
 */
function presenceOnly(code: string, start: number, end: number): boolean {
  const before = code.slice(Math.max(0, start - 9), start);
  if (/(?:!\s*|typeof\s+|Boolean\s*\(\s*)$/.test(before) && !/[!=]=\s*$/.test(before)) return true;
  const after = code.slice(skipWs(code, end), skipWs(code, end) + 9);
  if (/^\??\.\s*length\b/.test(after)) return true;
  if (/^(?:[!=]==?)/.test(after)) return true;
  if (/^\?(?![.?])/.test(after)) return true;
  return false;
}

/** Ключ объекта (`{ phone: x }`, `{ 'phone': x }`), а не значение. */
function objectKey(code: string, start: number, end: number): boolean {
  const next = skipWs(code, end);
  if (code[next] !== ':') return false;
  const prev = code[backWs(code, start) - 1];
  return prev === '{' || prev === ',';
}

/** Конец цепочки обращений (`lead.contact.phone` — от `lead` до `phone`). */
function chainEnd(code: string, at: number): number {
  let i = at;
  for (;;) {
    IDENT.lastIndex = i;
    const m = IDENT.exec(code);
    if (!m) return i;
    i = m.index + m[0].length;
    const j = skipWs(code, i);
    const dot = code.startsWith('?.', j) ? j + 2 : code[j] === '.' ? j + 1 : -1;
    if (dot < 0 || code[dot] === '.') return i;
    const k = skipWs(code, dot);
    if (!/[A-Za-z_$]/.test(code[k] ?? '')) return i;
    i = k;
  }
}

/**
 * ПД в отрезке кода [from, to): поле (`lead.phone`), переменная с именем ПД
 * (`touristPhone`) или имя владельца (`lead.name`). Чистки, проверки наличия
 * и ключи объектов пропускаются. Позиции — в `code`.
 */
export function pdRefsIn(
  code: string, from: number, to: number, skip?: RegExp,
): Array<{ at: number; expr: string; pd: 'contact' | 'name' }> {
  const out: Array<{ at: number; expr: string; pd: 'contact' | 'name' }> = [];
  const clean = sanitizedRanges(code, from, to);
  const inside = (at: number) => clean.some(([a, b]) => at > a && at < b);
  const seen = new Set<number>();
  const re = /(?<![\w$])[A-Za-z_$][\w$]*/g;
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    const head = m.index;
    const prev = code[backWs(code, head) - 1];
    // Середина цепочки разбирается от её головы.
    if (prev === '.' && code[backWs(code, head) - 2] !== '.') continue;
    if (inside(head)) continue;
    const end = Math.min(chainEnd(code, head), to);
    const chain = code.slice(head, end).replace(/\s+/g, '');
    re.lastIndex = end;
    // Вызов (`getPhone(…)`) — это функция, а не значение: её результат не виден.
    if (code[skipWs(code, end)] === '(') continue;
    if (objectKey(code, head, end)) continue;
    if (presenceOnly(code, head, end)) continue;
    const parts = chain.split(/\?\.|\./);
    if (skip && skip.test(snakeId(parts[parts.length - 1]))) continue;
    // `phone.length` — сколько, а не что.
    if (parts.length > 1 && parts[parts.length - 1] === 'length') continue;
    let pd: 'contact' | 'name' | null = null;
    for (const p of parts) { const k = pdKindOf(p); if (k === 'contact') { pd = 'contact'; break; } if (k === 'name') pd = 'name'; }
    if (!pd && PERSONAL_OWNER_NAME.test(chain.replace(/\?\./g, '.'))) {
      // `lead.name`, но не `lead.name_ru`: владелец и ровно поле `name`.
      const last = parts.slice(-2).join('.');
      if (new RegExp(`^(?:${PERSONAL_OWNER_NAME.source.replace(/^\\b|\\b$/g, '')})$`, 'i').test(last)) pd = 'name';
    }
    if (pd && !seen.has(head)) { seen.add(head); out.push({ at: head, expr: chain, pd }); }
  }
  return out;
}

/**
 * Адрес получателя в Telegram — не содержимое сообщения: без него сообщение не
 * отправить (`tgSend(contact.telegram_id, text)`). Telegram и так знает
 * номер чата своего пользователя.
 */
const TG_RECIPIENT = /^(?:[a-z0-9$]+_)*(?:telegram_id|telegram_chat_id|chat_id|tg_id)$/;

interface SinkSpan { kind: SinkKind; sink: string; from: number; to: number }

const LOG_CALL = /(?<![\w$.])(?:(console)\s*\.\s*(log|info|warn|error|debug|trace)|(logger)\s*\.\s*([a-z]+)|(process)\s*\.\s*(stdout|stderr)\s*\.\s*write|(log[A-Z][\w$]*(?:Failure|Error)|logSwallowedFailure))\s*\(/g;
const STORAGE_CALL = /(?<![\w$])(?:window\s*\.\s*)?(localStorage|sessionStorage)\s*\.\s*setItem\s*\(/g;
const STORAGE_ASSIGN = /(?<![\w$])(?:window\s*\.\s*)?(localStorage|sessionStorage)\s*(?:\[[^\]\n]*\]|\.\s*(?!setItem|getItem|removeItem|clear|key|length)[A-Za-z_$][\w$]*)\s*=(?!=)/g;
const COOKIE_ASSIGN = /(?<![\w$])document\s*\.\s*cookie\s*=(?!=)/g;
const IDB_WRITE = /\.\s*(put|add)\s*\(/g;
const TG_CALL = /(?<![\w$.])(tgSend|sendTelegramMessage|sendTelegram|telegramSend)\s*\(/g;
const PD_ALERT_CALL = /(?<![\w$.])sendPdAlert\s*\(/g;

/** Конец значения присваивания или свойства: до `;`, `,` или закрывающей скобки нулевой вложенности. */
function valueEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === ';' || c === ',')) return i;
  }
  return code.length;
}

/** Файл пишет в IndexedDB: импорт `idb` или прямой `indexedDB`. */
const usesIdb = (src: string): boolean => /from\s+['"]idb(?:-keyval)?['"]|\bindexedDB\s*\./.test(src);

/** Отрезки стоков файла по маске кода. */
function sinkSpans(src: string, code: string): SinkSpan[] {
  const out: SinkSpan[] = [];
  const call = (re: RegExp, kind: SinkKind, name: (m: RegExpExecArray) => string) => {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      // Объявление (`function logStayFailure(`) — не вызов.
      if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
      const open = m.index + m[0].length - 1;
      out.push({ kind, sink: name(m), from: open + 1, to: closeOf(code, open) });
    }
  };
  call(LOG_CALL, 'log', (m) => m[1] ? `console.${m[2]}` : m[3] ? `logger.${m[4]}` : m[5] ? `process.${m[6]}.write` : m[7]);
  call(STORAGE_CALL, 'storage', (m) => `${m[1]}.setItem`);
  call(TG_CALL, 'telegram', (m) => m[1]);
  for (const re of [STORAGE_ASSIGN, COOKIE_ASSIGN]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const from = m.index + m[0].length;
      out.push({ kind: 'storage', sink: m[1] ? `${m[1]}[…] =` : 'document.cookie =', from, to: valueEnd(code, from) });
    }
  }
  if (usesIdb(src)) call(IDB_WRITE, 'storage', (m) => `IndexedDB .${m[1]}`);
  // Заглушка sendPdAlert идёт в Telegram: ПД в ней быть не может по договору двери.
  PD_ALERT_CALL.lastIndex = 0;
  for (let m = PD_ALERT_CALL.exec(code); m; m = PD_ALERT_CALL.exec(code)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    const key = /(?<![\w$])stub\s*:/g;
    key.lastIndex = open;
    for (let k = key.exec(code); k && k.index < close; k = key.exec(code)) {
      const from = k.index + k[0].length;
      out.push({ kind: 'telegram', sink: 'sendPdAlert stub', from, to: valueEnd(code, from) });
    }
  }
  // Прямой запрос к api.telegram.org: аргументы fetch — текст для Telegram.
  const fetchRe = /(?<![\w$.])fetch\s*\(/g;
  for (let m = fetchRe.exec(code); m; m = fetchRe.exec(code)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    if (/api\.telegram\.org/.test(src.slice(open, close))) out.push({ kind: 'telegram', sink: 'fetch api.telegram.org', from: open + 1, to: close });
  }
  return out;
}

/**
 * Параметр строки запроса с ПД: `?phone=${…}`, `&email=${…}` — по тексту
 * исходника (имя параметра живёт в строке, маска его затирает).
 */
const URL_PARAM = /[?&]((?:[a-z]+_)*(?:phone|tel|email|e_mail|mobile|fio|full_name|client_name|tourist_name|guest_name|customer_name|contact_name))=\$\{/gi;
const SEARCH_SET = /\.\s*(?:set|append)\s*\(\s*['"]((?:[a-z]+_)*(?:phone|tel|email|mobile|fio|full_name|client_name|tourist_name|guest_name|customer_name|contact_name))['"]\s*,/gi;

function urlFindings(file: string, src: string, code: string, lineOf: (at: number) => number): SinkFinding[] {
  const out: SinkFinding[] = [];
  for (const m of src.matchAll(URL_PARAM)) {
    const at = (m.index ?? 0) + m[0].length - 1;
    // Строка в комментарии маской стёрта целиком вместе с `${`.
    if (code[at] !== '{' || code[at - 1] !== '$') continue;
    const close = closeOf(code, at);
    const expr = src.slice(at + 1, close).trim();
    if (sanitizedRanges(code, at, close).length > 0) continue;
    out.push({ file, line: lineOf(at), kind: 'url', sink: `адрес ?${m[1]}=`, expr, pd: /name|fio/i.test(m[1]) ? 'name' : 'contact' });
  }
  for (const m of src.matchAll(SEARCH_SET)) {
    const at = m.index ?? 0;
    if (!/[.]/.test(code[at] ?? '')) continue;
    // Только адрес: `searchParams`/`URLSearchParams`, а не Map или FormData тела запроса.
    const before = code.slice(Math.max(0, at - 40), at);
    if (!/(?:searchParams|params|query|qs|usp|url)\s*$/i.test(before)) continue;
    out.push({ file, line: lineOf(at), kind: 'url', sink: `адрес ${m[1]}`, expr: m[1], pd: /name|fio/i.test(m[1]) ? 'name' : 'contact' });
  }
  return out;
}

/** Находки одного исходника. Чистая функция. */
export function scanSinks(file: string, src: string): SinkFinding[] {
  const code = maskCode(src);
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (at: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out: SinkFinding[] = [];
  const seen = new Set<string>();
  for (const s of sinkSpans(src, code)) {
    for (const r of pdRefsIn(code, s.from, s.to, s.kind === 'telegram' ? TG_RECIPIENT : undefined)) {
      const id = `${s.kind}:${r.at}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ file, line: lineOf(r.at), kind: s.kind, sink: s.sink, expr: r.expr, pd: r.pd });
    }
  }
  out.push(...urlFindings(file, src, code, lineOf));
  return out;
}

/** Где файл пишет в хранилище устройства: API и ключ, если он виден. */
export interface DeviceWrite { line: number; api: 'localStorage' | 'sessionStorage' | 'IndexedDB' | 'Cache API' | 'cookie' }

/**
 * Все записи файла в хранилище устройства — для реестра: файл, который пишет
 * на устройство человека, обязан сказать, что там лежит.
 */
export function deviceWrites(src: string): DeviceWrite[] {
  const code = maskCode(src);
  const out: DeviceWrite[] = [];
  const lineOf = (at: number) => src.slice(0, at).split('\n').length;
  for (const re of [STORAGE_CALL, STORAGE_ASSIGN]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) out.push({ line: lineOf(m.index), api: m[1] as 'localStorage' | 'sessionStorage' });
  }
  COOKIE_ASSIGN.lastIndex = 0;
  for (let m = COOKIE_ASSIGN.exec(code); m; m = COOKIE_ASSIGN.exec(code)) out.push({ line: lineOf(m.index), api: 'cookie' });
  for (const m of code.matchAll(/(?<![\w$.])(?:openDB\s*(?:<[^>()]*>)?|indexedDB\s*\.\s*open)\s*\(/g)) out.push({ line: lineOf(m.index ?? 0), api: 'IndexedDB' });
  for (const m of code.matchAll(/(?<![\w$])caches\s*\.\s*open\s*\(/g)) out.push({ line: lineOf(m.index ?? 0), api: 'Cache API' });
  return out.sort((a, b) => a.line - b.line);
}
