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

export type SinkKind = 'storage' | 'log' | 'telegram' | 'url' | 'db';

export interface SinkFinding {
  file: string;
  line: number;
  kind: SinkKind;
  /** Сток словами: `localStorage.setItem`, `console.log`, `tgSend`, `адрес ?phone=`. */
  sink: string;
  /** Что ушло: `lead.phone`, `touristName`. */
  expr: string;
  pd: 'contact' | 'name';
  /** Сток `db`: таблицы, в которые пишет запрос (`INSERT INTO`, `UPDATE … SET`). */
  tables?: string[];
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

/**
 * Подпись автора сообщения: `fromName`, `author_name`, `sender_name`. В словаре
 * D1 их нет, а разведка по группам Telegram (#3460) хранила именно их — имя
 * человека из группы рядом с его словами.
 */
const AUTHOR_NAME = /^(?:[a-z0-9$]+_)*(?:from|author|sender|reviewer|commenter)_name$/;

/** Род ПД идентификатора или поля — или null. */
export function pdKindOf(id: string): 'contact' | 'name' | null {
  const s = snakeId(id);
  if (SERVICE_CONTACT.test(s)) return null;
  if (IP_ADDRESS.test(s)) return 'contact';
  if (NOT_PD_HERE.test(s)) return null;
  if (REDACTABLE_NAMED.test(s) || IDENT_NAMED.test(s)) return 'contact';
  if (PERSON_NAME.test(s) || AUTHOR_NAME.test(s)) return 'name';
  return null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;

/**
 * `lead['phone']` и `lead?.['phone']` → `lead.phone`: маска затирает строку в
 * скобках, и без приведения поле ПД не видно (D1 разбирает ту же форму).
 * Только доступ к члену — после имени, `)` или `]`; литерал массива
 * `= ['phone']` не трогается. Переводы строк не меняются: номера строк те же.
 */
export function normalizeBrackets(src: string): string {
  return src.replace(/(?<=[\w$)\]])\s*(\?\.)?\[\s*(['"])([A-Za-z_$][\w$]*)\2\s*\]/g, (_m, opt: string | undefined, _q: string, name: string) => `${opt ? '?.' : '.'}${name}`);
}

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
/**
 * Методы, которые возвращают «есть/где/сколько», а не значение:
 * `phone.includes('+7')` в логе — не номер.
 */
const NON_VALUE_METHODS: ReadonlySet<string> = new Set([
  'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'search', 'localeCompare', 'hasOwnProperty', 'test',
]);

export type PdRef = { at: number; expr: string; pd: 'contact' | 'name' };

/**
 * ПД в отрезке кода [from, to). `resolve` — один шаг по локальной переменной:
 * голое имя без ПД в названии (`text`) разбирается по своему объявлению
 * (`const text = …booking.passengerPhone…`). Дальше одного шага сторож
 * не идёт: глубокий поток — работа D1 для своего стока.
 */
export function pdRefsIn(
  code: string, from: number, to: number, skip?: RegExp,
  resolve?: (name: string, at: number) => PdRef[],
): PdRef[] {
  const out: PdRef[] = [];
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
    let chain = code.slice(head, end).replace(/\s+/g, '');
    re.lastIndex = end;
    let parts = chain.split(/\?\.|\./);
    if (code[skipWs(code, end)] === '(') {
      // Вызов (`getPhone(…)`) — это функция, а не значение: её результат не
      // виден. Но метод ПОСЛЕ поля (`lead.phone.trim()`) отдаёт само значение.
      if (parts.length < 2 || NON_VALUE_METHODS.has(parts[parts.length - 1])) continue;
      parts = parts.slice(0, -1);
      chain = parts.join('.');
    } else {
      if (objectKey(code, head, end)) continue;
      if (presenceOnly(code, head, end)) continue;
    }
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
    if (pd && !seen.has(head)) { seen.add(head); out.push({ at: head, expr: chain, pd }); continue; }
    if (!pd && resolve && parts.length === 1 && !seen.has(head)) {
      for (const r of resolve(parts[0], head)) { seen.add(head); out.push(r); }
    }
  }
  return out;
}

/**
 * Объявления локальных переменных файла: имя → отрезки инициализаторов.
 * Деструктуризация не нужна: её имена сами названы полями (`{ phone }`).
 */
function localInits(code: string): Map<string, Array<{ at: number; from: number; to: number }>> {
  const out = new Map<string, Array<{ at: number; from: number; to: number }>>();
  const re = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?![=>])/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const from = m.index + m[0].length;
    const list = out.get(m[1]) ?? [];
    list.push({ at: m.index, from, to: valueEnd(code, from) });
    out.set(m[1], list);
  }
  return out;
}

/**
 * Адрес получателя в Telegram — не содержимое сообщения: без него сообщение не
 * отправить (`tgSend(contact.telegram_id, text)`). Telegram и так знает
 * номер чата своего пользователя.
 */
const TG_RECIPIENT = /^(?:[a-z0-9$]+_)*(?:telegram_id|telegram_chat_id|chat_id|tg_id)$/;

interface SinkSpan { kind: SinkKind; sink: string; from: number; to: number; tables?: string[] }

const LOG_CALL = /(?<![\w$.])(?:(console)\s*\.\s*(log|info|warn|error|debug|trace)|(logger)\s*\.\s*([a-z]+)|(process)\s*\.\s*(stdout|stderr)\s*\.\s*write|(log[A-Z][\w$]*(?:Failure|Error)|logSwallowedFailure))\s*\(/g;
/**
 * Запись в Web Storage — любой `.setItem(`: через `localStorage`, через
 * `globalThis.localStorage?.`, через переданный объект (`storage.setItem`,
 * `storeFor(x).setItem`). Метод с этим именем в коде платформы есть только у
 * Storage; подставленное хранилище — тот же localStorage (`last-fix.ts`).
 */
const STORAGE_CALL = /\??\.\s*setItem\s*\(/g;
const STORAGE_NAMED = /(localStorage|sessionStorage)\s*\??$/;
const STORAGE_ASSIGN = /(?<![\w$])(?:(?:window|globalThis|self)\s*\??\.\s*)?(localStorage|sessionStorage)\s*(?:\[[^\]\n]*\]|\??\.\s*(?!setItem|getItem|removeItem|clear|key|length)[A-Za-z_$][\w$]*)\s*=(?!=)/g;
/** Хранилище, которым пишет `.setItem(` на позиции `at`: имя или «Storage». */
const storageApi = (code: string, at: number): 'localStorage' | 'sessionStorage' | 'Storage' =>
  (STORAGE_NAMED.exec(code.slice(Math.max(0, at - 20), at).trimEnd())?.[1] as 'localStorage' | 'sessionStorage' | undefined) ?? 'Storage';
const COOKIE_ASSIGN = /(?<![\w$])document\s*\.\s*cookie\s*=(?!=)/g;
const IDB_WRITE = /\.\s*(put|add)\s*\(/g;
const TG_CALL = /(?<![\w$.])(tgSend|sendTelegramMessage|sendTelegram|telegramSend|telegramService\s*\.\s*(?:sendMessage|editMessageText|sendPhoto|sendDocument))\s*\(/g;
/** Внутри клиента Telegram (файл знает его хост) — свой метод отправки. */
const TG_SELF_CALL = /(?<![\w$.])this\s*\.\s*(sendMessage|editMessageText|sendPhoto|sendDocument)\s*\(/g;
/** Файл ходит на api.telegram.org — хост в литерале, геттере или переменной. */
const talksToTelegram = (src: string): boolean => /api\.telegram\.org|TELEGRAM_API_BASE/.test(src);
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

/**
 * Запрос к базе: `pool.query(`, `client.query(`, `db.query(`, `query<Row>(` и
 * голый `query(` из `lib/database`. Сток — только запрос, который ПИШЕТ
 * (`INSERT INTO`, `UPDATE … SET`): чтение ПД из базы не кладёт их никуда.
 * Тегированный шаблон (`sql\`…\``) не разбирается — он назван ограничением.
 */
const DB_CALL = /(?<![\w$])(?:[A-Za-z_$][\w$]*\s*\??\.\s*)?query\s*(?:<[^()]*?>)?\s*\(/g;
const SQL_INSERT = /\bINSERT\s+INTO\s+(?:ONLY\s+)?("?[A-Za-z_][\w.]*"?|\$\{)/gi;
const SQL_UPDATE = /(?<!\bDO\s+)\bUPDATE\s+(?:ONLY\s+)?("?[A-Za-z_][\w.]*"?|\$\{)(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b/gi;

/** Записи текста запроса: `public.leads` → `leads`, `${t}` → `(имя в переменной)`. */
export function sqlWrites(sql: string): Array<{ op: 'INSERT INTO' | 'UPDATE'; table: string }> {
  const out: Array<{ op: 'INSERT INTO' | 'UPDATE'; table: string }> = [];
  const seen = new Set<string>();
  for (const [op, re] of [['INSERT INTO', SQL_INSERT], ['UPDATE', SQL_UPDATE]] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      const table = m[1] === '${' ? '(имя в переменной)' : m[1].replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
      if (table === 'set' || seen.has(`${op} ${table}`)) continue;
      seen.add(`${op} ${table}`);
      out.push({ op, table });
    }
  }
  return out;
}

/** Файл пишет в IndexedDB: импорт `idb` или прямой `indexedDB`. */
const usesIdb = (src: string): boolean => /from\s+['"]idb(?:-keyval)?['"]|\bindexedDB\s*\./.test(src);

/** Отрезки стоков файла по маске кода. */
function sinkSpans(src: string, code: string, inits: ReturnType<typeof localInits>): SinkSpan[] {
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
  call(STORAGE_CALL, 'storage', (m) => `${storageApi(code, m.index)}.setItem`);
  call(TG_CALL, 'telegram', (m) => m[1].replace(/\s+/g, ''));
  if (talksToTelegram(src)) call(TG_SELF_CALL, 'telegram', (m) => `this.${m[1]}`);
  for (const re of [STORAGE_ASSIGN, COOKIE_ASSIGN]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const from = m.index + m[0].length;
      out.push({ kind: 'storage', sink: m[1] ? `${m[1]}[…] =` : 'document.cookie =', from, to: valueEnd(code, from) });
    }
  }
  if (usesIdb(src)) call(IDB_WRITE, 'storage', (m) => `IndexedDB .${m[1]}`);
  // Запись в базу: текст запроса — первый аргумент, литералом или константой
  // (один шаг, как у переменных стока); ПД ищутся во всём вызове.
  DB_CALL.lastIndex = 0;
  for (let m = DB_CALL.exec(code); m; m = DB_CALL.exec(code)) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const firstEnd = valueEnd(code, open + 1);
    let sql = src.slice(open + 1, firstEnd);
    const ref = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(sql);
    if (ref) {
      const decl = (inits.get(ref[1]) ?? []).filter((d) => d.at < m!.index).pop() ?? (inits.get(ref[1]) ?? [])[0];
      sql = decl ? src.slice(decl.from, decl.to) : '';
    }
    const writes = sqlWrites(sql);
    if (writes.length === 0) continue;
    const tables = [...new Set(writes.map((w) => w.table))];
    const sink = writes.map((w) => `${w.op} ${w.table}`).join(' / ');
    out.push({ kind: 'db', sink, from: open + 1, to: closeOf(code, open), tables });
  }
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
  // Запрос к api.telegram.org: в файле, который знает этот хост (литералом,
  // геттером `baseUrl` или переменной), аргументы fetch — текст для Telegram.
  if (talksToTelegram(src)) {
    const fetchRe = /(?<![\w$.])fetch\s*\(/g;
    for (let m = fetchRe.exec(code); m; m = fetchRe.exec(code)) {
      const open = m.index + m[0].length - 1;
      out.push({ kind: 'telegram', sink: 'fetch api.telegram.org', from: open + 1, to: closeOf(code, open) });
    }
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

/**
 * Поля файла, которым он сам дал значение с ПД: `{ from: fromName }` делает
 * `m.from` в этом файле именем человека. Один шаг: поле, значение которому
 * дала другая переменная без ПД в названии, не прослеживается. Только для
 * записи в базу — там значение лежит годами.
 */
function pdFields(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?<=[{,]\s*)([A-Za-z_$][\w$]*)\s*:(?![:=])/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (pdKindOf(m[1])) continue;
    const from = m.index + m[0].length;
    const refs = pdRefsIn(code, from, valueEnd(code, from));
    if (refs.length > 0 && !out.has(m[1])) out.set(m[1], `${m[1]}: ${refs[0].expr}`);
  }
  return out;
}

/** Обращения к полям `fields` в [from, to): `m.from`, `x?.from`. */
function fieldRefsIn(code: string, from: number, to: number, fields: Map<string, string>): PdRef[] {
  if (fields.size === 0) return [];
  const out: PdRef[] = [];
  const clean = sanitizedRanges(code, from, to);
  const re = /([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    const field = m[2];
    const how = fields.get(field);
    if (!how) { re.lastIndex = m.index + m[1].length; continue; }
    const at = m.index;
    const end = at + m[0].length;
    if (clean.some(([a, b]) => at > a && at < b)) continue;
    if (code[skipWs(code, end)] === '(' || presenceOnly(code, at, end)) continue;
    out.push({ at, expr: `${m[1]}.${field} ← ${how}`, pd: 'name' });
  }
  return out;
}

/** Находки одного исходника. Чистая функция. */
export function scanSinks(file: string, raw: string): SinkFinding[] {
  const src = normalizeBrackets(raw);
  const code = maskCode(src);
  const inits = localInits(code);
  /** Один шаг по переменной: последнее объявление до стока, без вложенного шага. */
  const resolveFor = (skip?: RegExp) => (name: string, at: number): PdRef[] => {
    const decl = (inits.get(name) ?? []).filter((d) => d.at < at).pop();
    if (!decl || (at >= decl.from && at <= decl.to)) return [];
    return pdRefsIn(code, decl.from, decl.to, skip).map((r) => ({ ...r, expr: `${name} ← ${r.expr}` }));
  };
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (at: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out: SinkFinding[] = [];
  const seen = new Set<string>();
  const spans = sinkSpans(src, code, inits);
  const fields = spans.some((s) => s.kind === 'db') ? pdFields(code) : new Map<string, string>();
  for (const s of spans) {
    const skip = s.kind === 'telegram' ? TG_RECIPIENT : undefined;
    const refs = pdRefsIn(code, s.from, s.to, skip, resolveFor(skip));
    if (s.kind === 'db') refs.push(...fieldRefsIn(code, s.from, s.to, fields));
    for (const r of refs) {
      const id = `${s.kind}:${r.at}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ file, line: lineOf(r.at), kind: s.kind, sink: s.sink, expr: r.expr, pd: r.pd, ...(s.tables ? { tables: s.tables } : {}) });
    }
  }
  out.push(...urlFindings(file, src, code, lineOf));
  return out;
}

/** Где файл пишет в хранилище устройства: API и ключ, если он виден. */
export interface DeviceWrite { line: number; api: 'localStorage' | 'sessionStorage' | 'Storage' | 'IndexedDB' | 'Cache API' | 'cookie' }

/**
 * Все записи файла в хранилище устройства — для реестра: файл, который пишет
 * на устройство человека, обязан сказать, что там лежит.
 */
export function deviceWrites(raw: string): DeviceWrite[] {
  const src = normalizeBrackets(raw);
  const code = maskCode(src);
  const out: DeviceWrite[] = [];
  const lineOf = (at: number) => src.slice(0, at).split('\n').length;
  STORAGE_CALL.lastIndex = 0;
  for (let m = STORAGE_CALL.exec(code); m; m = STORAGE_CALL.exec(code)) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push({ line: lineOf(m.index), api: storageApi(code, m.index) });
  }
  STORAGE_ASSIGN.lastIndex = 0;
  for (let m = STORAGE_ASSIGN.exec(code); m; m = STORAGE_ASSIGN.exec(code)) out.push({ line: lineOf(m.index), api: m[1] as 'localStorage' | 'sessionStorage' });
  COOKIE_ASSIGN.lastIndex = 0;
  for (let m = COOKIE_ASSIGN.exec(code); m; m = COOKIE_ASSIGN.exec(code)) out.push({ line: lineOf(m.index), api: 'cookie' });
  for (const m of code.matchAll(/(?<![\w$.])(?:openDB\s*(?:<[^>()]*>)?|indexedDB\s*\.\s*open)\s*\(/g)) out.push({ line: lineOf(m.index ?? 0), api: 'IndexedDB' });
  for (const m of code.matchAll(/(?<![\w$])caches\s*\.\s*open\s*\(/g)) out.push({ line: lineOf(m.index ?? 0), api: 'Cache API' });
  return out.sort((a, b) => a.line - b.line);
}
