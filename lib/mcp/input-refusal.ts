/**
 * Отказ заявке по входу — на двух языках, целиком и с именами полей
 * (слово владельца 13.11: «как Кузьмич запрашивает согласие, может, согласие
 * не доходит? нужна проверка и в случае дыры необходимо решение»).
 *
 * ── Что нашлось ───────────────────────────────────────────────────────────
 *
 * Пробный прогон того дня (заявки с `test: true`) показал три дыры в том, как
 * пишущие инструменты говорят агенту «не то»:
 *
 *  1. Отказ был только по-русски, а в журнале — китайские и английские агенты.
 *  2. Назывался ПЕРВЫЙ отказ, а не все: `consent: false` с выдуманным
 *     телефоном давали ответ только про телефон. Агент чинил номер и получал
 *     второй отказ — уже про согласие.
 *  3. Поле не называлось: «Invalid input: expected string, received
 *     undefined» — стандартная строка Zod, по которой не понять, что править.
 *     Поле, названное не так (`tour_id` вместо `tour`), молча отбрасывалось.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Один сборщик отказа: список «поле — что не так» по-русски и по-английски,
 * все найденные поля разом. Русская строка — свои слова схемы, если они есть;
 * английская строится из рода ошибки (нет поля, не тот тип, коротко, длинно),
 * чтобы не переводить руками полсотни сообщений и не разойтись с ними.
 *
 * Согласие — три разных случая с разными словами, и это намеренно (шапка
 * `consentField` в роуте): поля нет — агент шлёт запрос по старой схеме; поле
 * не логическое; согласия нет — человека не спросили или он отказал.
 *
 * Чистый модуль: ни базы, ни сети. Сторож: tests/unit/mcp-input-refusal.test.ts.
 */

export interface InputProblem {
  /** Имя поля, как его ждёт инструмент. */
  field: string;
  ru: string;
  en: string;
  /** Русская строка — слова самой схемы (они обычно уже называют поле), а не общий оборот. */
  own?: boolean;
}

/** Ошибка проверки схемы — то, что нужно от записи Zod. */
export interface SchemaIssue {
  code?: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
  expected?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  values?: unknown;
  /** Своё правило схемы (`.refine`) помечает `{ missing: true }`, когда оно про пропавшее поле. */
  params?: unknown;
}

export type ConsentCase = 'missing' | 'not_boolean' | 'refused';

const CONSENT: Record<ConsentCase, { ru: string; en: string }> = {
  missing: {
    ru: 'в запросе нет поля consent. Спросите у человека согласие на обработку персональных данных (имя, телефон) и передайте consent: true',
    en: 'the consent field is missing. Ask the person for consent to personal-data processing (name, phone) and pass consent: true',
  },
  not_boolean: {
    ru: 'должно быть логическим значением true или false, а не строкой',
    en: 'must be a boolean true or false, not a string',
  },
  refused: {
    ru: 'нет согласия на обработку персональных данных (consent: false). Спросите человека прямо и передайте consent: true — без этого имя и телефон принимать нельзя',
    en: 'no consent to personal-data processing (consent: false). Ask the person directly and pass consent: true — name and phone cannot be accepted without it',
  },
};

export function consentProblem(kind: ConsentCase): InputProblem {
  return { field: 'consent', ...CONSENT[kind] };
}

/** Что не так с полем consent в сыром запросе; null — согласие дано. */
export function consentCase(raw: unknown): ConsentCase | null {
  if (raw === true) return null;
  if (raw === undefined || raw === null) return 'missing';
  return raw === false ? 'refused' : 'not_boolean';
}

export type PhoneCase = 'bad' | 'implausible';

const PHONE: Record<PhoneCase, { ru: string; en: string }> = {
  bad: {
    ru: 'не похож на номер: нужно 10–15 цифр, например +79001234567',
    en: 'does not look like a phone number: 10–15 digits are needed, e.g. +79001234567',
  },
  implausible: {
    ru: 'такого номера не бывает (в зоне +7 нет кодов на 0, 1 и 2, а номер из одних одинаковых цифр не набрать). Спросите у человека его номер. Чтобы проверить интеграцию, не отправляя заявку, передайте test: true',
    en: 'no such number exists (+7 has no codes starting with 0, 1 or 2, and a number of identical digits cannot be dialled). Ask the person for their real number. To test the integration without sending a request, pass test: true',
  },
};

export function phoneProblem(kind: PhoneCase): InputProblem {
  return { field: 'phone', ...PHONE[kind] };
}

/** Стандартная английская строка Zod — не слова схемы: её заменяем своими. */
const ZOD_DEFAULT = /^(Invalid |Too small|Too big|Unrecognized |Expected )/;

const TYPE_RU: Record<string, string> = {
  string: 'строкой', number: 'числом', int: 'целым числом', boolean: 'логическим значением true или false',
  array: 'списком', object: 'объектом', date: 'датой',
};

const num = (v: unknown): string => (typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');

function genericRu(issue: SchemaIssue, missing: boolean): string {
  if (missing) return 'обязательное поле, в запросе его нет';
  switch (issue.code) {
    case 'invalid_type': return `должно быть ${TYPE_RU[String(issue.expected)] ?? `типа ${String(issue.expected)}`}`;
    case 'too_small': return issue.origin === 'string' ? `слишком короткое (не меньше ${num(issue.minimum)} знаков)` : `слишком маленькое (не меньше ${num(issue.minimum)})`;
    case 'too_big': return issue.origin === 'string' ? `слишком длинное (не больше ${num(issue.maximum)} знаков)` : `слишком большое (не больше ${num(issue.maximum)})`;
    case 'invalid_format': return 'неверный формат';
    case 'invalid_value': return Array.isArray(issue.values) ? `допустимые значения: ${issue.values.map(String).join(', ')}` : 'недопустимое значение';
    default: return 'неверное значение';
  }
}

function genericEn(issue: SchemaIssue, missing: boolean): string {
  if (missing) return 'required field is missing';
  switch (issue.code) {
    case 'invalid_type': return `must be ${String(issue.expected) === 'int' ? 'an integer' : `a ${String(issue.expected)}`}`;
    case 'too_small': return issue.origin === 'string' ? `too short (at least ${num(issue.minimum)} characters)` : `too small (at least ${num(issue.minimum)})`;
    case 'too_big': return issue.origin === 'string' ? `too long (at most ${num(issue.maximum)} characters)` : `too large (at most ${num(issue.maximum)})`;
    case 'invalid_format': return 'invalid format';
    case 'invalid_value': return Array.isArray(issue.values) ? `allowed values: ${issue.values.map(String).join(', ')}` : 'value is not allowed';
    default: return 'invalid value';
  }
}

/**
 * Ошибки схемы → список «поле — что не так». По одной записи на поле: вторая
 * ошибка того же поля агенту ничего не добавляет. Согласие получает свои
 * слова по сырому значению, а не по тексту ошибки.
 */
export function problemsFromIssues(issues: ReadonlyArray<SchemaIssue>, raw: Readonly<Record<string, unknown>>): InputProblem[] {
  const out: InputProblem[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '');
    if (seen.has(field)) continue;
    seen.add(field);
    if (field === 'consent') {
      out.push(consentProblem(consentCase(raw.consent) ?? 'not_boolean'));
      continue;
    }
    // Пропавшее поле: его нет в запросе, а схема ждала значение (`invalid_type`),
    // либо своё правило схемы само сказало, что оно про пропажу (`params.missing`,
    // у полей с синонимами). Просто `custom` пропажей не считается: правило
    // «туров должно быть от двух до четырёх» срабатывает и на поле, пришедшее
    // под синонимом, и «поле пропало» было бы там неправдой.
    const flagged = issue.code === 'custom' && (issue.params as { missing?: unknown } | undefined)?.missing === true;
    const missing = field !== '' && (raw[field] === undefined || raw[field] === null)
      && (issue.code === 'invalid_type' || flagged);
    // Свои слова схемы точнее общего оборота и у пропавшего поля: «нужно
    // указать name (название места)» говорит больше, чем «обязательное поле».
    const own = !ZOD_DEFAULT.test(issue.message);
    // Слова схемы, начатые именем поля («notify_url: адрес…», «action — cancel
    // или…»), — без него: имя уже стоит в начале строки списка.
    const lead = field ? [`${field}: `, `${field} — `].find((x) => issue.message.startsWith(x)) : undefined;
    const words = lead ? issue.message.slice(lead.length) : issue.message;
    out.push({
      field: field || 'arguments',
      ru: own ? words : genericRu(issue, missing),
      en: genericEn(issue, missing),
      own,
    });
  }
  return out;
}

/**
 * Поля запроса, которых у инструмента нет. Называются только рядом с
 * пропавшим обязательным полем: тогда лишнее поле — скорее всего оно же под
 * другим именем (`tour_id` вместо `tour`). Сами по себе лишние поля не ошибка.
 */
export function unknownFields(raw: Readonly<Record<string, unknown>>, known: ReadonlyArray<string>): string[] {
  const set = new Set(known);
  // В отказ идёт только то, что похоже на имя поля: ключ запроса пишет агент, и
  // ключ в килобайт или с чужим текстом вернулся бы в ответе и лёг в задачу A2A.
  return Object.keys(raw).filter((k) => !set.has(k) && k !== 'test' && FIELD_NAME.test(k)).slice(0, 8);
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const line = (p: InputProblem, lang: 'ru' | 'en'): string => `• ${p.field} — ${lang === 'ru' ? p.ru : p.en}`;

/** Что не случилось из-за отказа: заявка не создана или не изменена. */
export interface RefusalHead { ru: string; en: string }
export const REQUEST_NOT_CREATED: RefusalHead = { ru: 'Заявка не создана', en: 'Request not created' };
export const REQUEST_NOT_CHANGED: RefusalHead = { ru: 'Заявка не изменена', en: 'Request not changed' };

/**
 * Текст отказа: сперва по-русски, затем по-английски, одно и то же. Пустой
 * список сюда не приходит: отказ без причины — не отказ.
 */
export function inputRefusalText(
  problems: ReadonlyArray<InputProblem>,
  unknown: ReadonlyArray<string> = [],
  head: RefusalHead = REQUEST_NOT_CREATED,
): string {
  const one = problems.length === 1;
  const ru = [
    `${head.ru} — ${one ? 'исправьте и повторите вызов' : 'исправьте всё из списка и повторите вызов'}:`,
    ...problems.map((p) => line(p, 'ru')),
    unknown.length > 0 ? `В запросе есть поля, которых у инструмента нет: ${unknown.join(', ')} — проверьте названия полей по схеме инструмента.` : '',
  ];
  const en = [
    `${head.en} — ${one ? 'fix this and call again' : 'fix everything listed and call again'}:`,
    ...problems.map((p) => line(p, 'en')),
    unknown.length > 0 ? `Unknown fields in the request: ${unknown.join(', ')} — check field names against the tool schema.` : '',
  ];
  return [...ru.filter(Boolean), '', ...en.filter(Boolean)].join('\n');
}

/**
 * Английская половина отказа читающему инструменту (поиск туров, справка о
 * месте): русскую фразу собирает сам валидатор (lib/kuzmich/tool-schemas) —
 * её же читает модель Кузьмича, — а внешнему агенту рядом нужна английская.
 */
export function argsRefusalEn(problems: ReadonlyArray<InputProblem>): string {
  if (problems.length === 0) return 'Arguments failed validation — check them against the tool schema and call again.';
  return ['Arguments failed validation — fix and call again:', ...problems.map((p) => line(p, 'en'))].join('\n');
}

/**
 * Приписка к отказу по делу (нет мест, тур не найден), когда согласия при
 * этом тоже нет: иначе агент исправит дело и получит второй отказ.
 */
export const CONSENT_ALSO_NOTE = [
  `И ещё: ${CONSENT.refused.ru}.`,
  `Also: ${CONSENT.refused.en}.`,
].join('\n');
