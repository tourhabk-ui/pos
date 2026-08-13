/**
 * Страж достоверности находок — детерминированный слой между LLM-сканером
 * (aiCodeReview, Gemini) и записью в evo_growth_issues.
 *
 * Зачем: ночью Growth Scan выдавал галлюцинации, которые тихо копились как
 * «проблемы» и пошли бы в GitHub Issues:
 *   - «Прямой вызов callAIFast — нарушение конвенции» — ЛОЖЬ: CLAUDE.md §4
 *     разрешает callAIFast() наравне с callAIWaterfall().
 *   - «console.error в saveBotMemory — нарушение» — ЛОЖЬ: запрещён console.log,
 *     а console.error в catch разрешён.
 *   - «Использование callAIWaterfall вместо callAIWaterfall» — бессмыслица
 *     (заменить X на тот же X).
 *
 * Guard кодирует РЕАЛЬНЫЕ правила проекта и режет находки, им противоречащие.
 * Консервативен: глушит только явно-ложное, настоящие находки (SQL-инъекция,
 * дыра auth, console.log в проде, прямой callDeepSeek) проходят.
 *
 * Чистые функции — под тестом. НЕ ловит семантические галлюцинации, требующие
 * сверки с телом файла (напр. «внешний вызов без try/catch», когда try/catch
 * есть) — это отдельный класс, для него нужен верификационный проход.
 */

export interface CandidateFinding {
  title: string;
  description: string;
  suggestion: string;
}

/** «X вместо X» / «заменить X на X» — предложение заменить токен на тот же токен. */
function incoherentSameToken(text: string): boolean {
  // Латинские идентификаторы (callAIFast и т.п.); кириллицу не трогаем —
  // «строк вместо параметров» это осмысленно.
  const m1 = text.match(/([A-Za-z_][\w.]{3,})\s+(?:вместо|instead of)\s+([A-Za-z_][\w.]{3,})/i);
  if (m1 && m1[1].toLowerCase() === m1[2].toLowerCase()) return true;

  const m2 = text.match(/замен\w*\s+([A-Za-z_][\w.]{3,})\s+на\s+([A-Za-z_][\w.]{3,})/i);
  if (m2 && m2[1].toLowerCase() === m2[2].toLowerCase()) return true;

  return false;
}

/**
 * callAIFast заклеймён нарушением. CLAUDE.md §4: callAIFast() — санкционированная
 * точка входа наравне с callAIWaterfall(). Находка «заменить callAIFast на
 * callAIWaterfall» / «callAIFast нарушает конвенцию» — ложная.
 * НЕ глушим «callAIFast без try/catch» (это другой, возможно реальный, класс).
 */
function flagsSanctionedCallAIFast(text: string): boolean {
  if (!/callAIFast/i.test(text)) return false;
  return /callAIWaterfall/i.test(text) || /(нарушени|конвенци|instead|вместо|замен)/i.test(text);
}

/**
 * console.error заклеймён нарушением. CLAUDE.md: запрещён console.log; console.error
 * в catch — разрешён. Глушим только когда клеймят именно console.error и рядом нет
 * console.log (тот — реальное нарушение, не трогаем).
 */
function flagsSanctionedConsoleError(text: string): boolean {
  if (!/console\.error/i.test(text)) return false;
  if (/console\.log/i.test(text)) return false;
  return /(нарушени|конвенци|логгер|logger|замен|вместо|instead|не следует|запрещ)/i.test(text);
}

/**
 * Ссылки на чужой стек. Проект — прямой SQL + свой JWT (CLAUDE.md §1): Prisma,
 * NextAuth, getServerSession здесь не существуют. Находка, чинящая их, —
 * галлюцинация (кейс: 10 issues по booking-роуту с «оберни в Prisma-транзакцию»
 * и «getServerSession»). Content-free — не нужен файл.
 */
function flagsForeignStack(text: string): boolean {
  return /\bprisma\b|@prisma|prismaclient|next-auth|nextauth|getserversession/i.test(text);
}

/**
 * Причина отклонить находку как недостоверную, либо null если находка проходит.
 * Строка-код причины идёт в телеметрию скана.
 */
/**
 * Находка не о продукте, а о самом прогоне: модели не передали содержимое
 * файлов, и она честно об этом сообщает.
 *
 * Кейс — issue #1020 «Содержимое файлов не передано (high)»: модель написала,
 * что без кода «любые выводы были бы выдумкой», и была права. Но это дефект
 * конвейера, а не баг платформы, и в Issues он попал с меткой high severity.
 * То есть сбой сканирования выглядел как результат сканирования — ровно тот
 * класс, против которого весь этот страж и заведён.
 *
 * Такую находку надо гасить и чинить прогон, а не заводить задачу разработчику.
 */
function complainsAboutMissingInput(text: string): boolean {
  const noInput = /содержимо[а-яё]*\s+файл[а-яё]*\s+не\s+(?:передан|предоставл|прилож)|сам\s+код\s+не\s+прилож|указаны\s+только\s+пути|file\s+contents?\s+(?:were\s+)?not\s+(?:provided|supplied|included)|no\s+(?:file\s+)?(?:contents?|source)\s+(?:was\s+)?provided/i;
  const cannotAnalyse = /невозможно\s+пров[ео]сти\s+анализ|анализ\s+невозможен|были\s+бы\s+выдумкой|cannot\s+(?:perform|do)\s+(?:the\s+)?analysis|unable\s+to\s+analy[sz]e/i;
  const asksForCode = /запросить\s+у\s+пользовател[а-яё]*\s+.{0,40}код|请求|provide\s+the\s+(?:full\s+)?(?:code|source)/i;
  return noInput.test(text) || (cannotAnalyse.test(text) && asksForCode.test(text));
}

export function findingRejectionReason(f: CandidateFinding): string | null {
  const text = `${f.title} ${f.description} ${f.suggestion}`;
  if (complainsAboutMissingInput(text)) return 'scan_input_missing';
  if (incoherentSameToken(text)) return 'incoherent_same_token';
  if (flagsSanctionedCallAIFast(text)) return 'sanctioned_callaifast';
  if (flagsSanctionedConsoleError(text)) return 'sanctioned_console_error';
  if (flagsForeignStack(text)) return 'foreign_stack';
  if (quotesPlaceholderAsUnsafe(text)) return 'quotes_placeholder_as_unsafe';
  return null;
}

export function isCredibleFinding(f: CandidateFinding): boolean {
  return findingRejectionReason(f) === null;
}

// ── Верификационный проход: сверка находки с телом файла ──────────────────────
// Отдельный класс галлюцинаций — «отсутствует X», когда X в файле ЕСТЬ
// (кейс: «нет try/catch»/«нет auth»/«race condition без блокировки» на
// booking-роуте, где есть и try/catch, и verifyToken, и FOR UPDATE). Guard
// выше content-free и такое не ловит — здесь сверяем с исходником.

// ВАЖНО про русские окончания: в JS \w это [A-Za-z0-9_] — кириллицу он НЕ
// матчит. Поэтому «отсутству\w*\s+обработк\w*», «проверк\w*\s+прав»,
// «двойн\w*\s+брон» были мёртвыми ветками: на «проверки прав» страж молчал.
// Инцидент 24.07 (10 ложных находок прошли наружу) — в том числе из-за этого.
// Русская морфология — только через [а-яё]*.

/** Находка о «нет обработки ошибок / нет try/catch». */
function claimsMissingTryCatch(text: string): boolean {
  return /try\s*\/?\s*catch|не\s*об[её]рнут|без\s+try|отсутству[а-яё]*\s+(?:try|обработк[а-яё]*\s+ошибок)|missing\s+(?:error\s+handling|try)|not\s+wrapped|unhandled\s+(?:exception|rejection)|необрабатываем/i.test(text);
}
/** Находка о «нет проверки авторизации/аутентификации». */
function claimsMissingAuth(text: string): boolean {
  return /авториз|аутентифик|auth(?:enticat|oriz)|\brequireauth\b|проверк[а-яё]*\s+прав|userid\s+(?:из|from)\s+(?:body|тела|request|запрос)|no\s+auth|unauthenticated/i.test(text);
}
/** Находка о «race condition / нет блокировки». */
function claimsMissingLock(text: string): boolean {
  return /race\s*condition|гонк[а-яё]|блокиров|locking|конкурент|concurrent|пессимист|oversell|двойн[а-яё]*\s+брон/i.test(text);
}

/** Находка о «нет валидации входных данных / тело без проверок». */
function claimsMissingValidation(text: string): boolean {
  return /валидац|validat[a-z]*|не\s+провер[а-яё]*\s+(?:тел[а-яё]*|данн[а-яё]*|вход)|without\s+(?:\w+\s+)?(?:checks|validation)|unvalidated|malformed\s+or\s+malicious|directly\s+passed/i.test(text);
}

/**
 * Находка о SQL-инъекции: якобы конкатенация/интерполяция пользовательского
 * ввода в запрос.
 */
function claimsSqlInjection(text: string): boolean {
  return /sql[-\s]?инъекц|sql\s*injection|конкатенац[а-яё]*\s*(?:в\s*)?sql|непараметризован|без\s+параметризац|вместо\s+параметризованн/i.test(text);
}

/**
 * Находка сама себе противоречит: клеймит запрос непараметризованным и тут же
 * цитирует плейсхолдер `$1`. Реальный кейс — issue #776 про lib/kuzmich/core.ts:
 * «использует параметр напрямую в строке запроса без параметризации:
 * WHERE telegram_chat_id = $1». `$1` И ЕСТЬ параметризация. Проверка
 * content-free: тело файла для неё не нужно.
 */
function quotesPlaceholderAsUnsafe(text: string): boolean {
  if (!claimsSqlInjection(text)) return false;
  // Плейсхолдер в кавычках/бэктиках или сразу после сравнения — то, что модель
  // выдаёт за уязвимый код.
  return /=\s*\$\d\b/.test(text);
}

/** Есть ли в исходнике конструкция, наличие которой опровергает находку. */
function sourceHasTryCatch(src: string): boolean {
  return /\btry\s*\{/.test(src) && /\bcatch\b/.test(src);
}
function sourceHasAuth(src: string): boolean {
  return /verifyToken|extractToken|requireAuth|requireAdmin|requireRole|verifyJWT|getUserFrom|auth_token|verifySession/i.test(src);
}
function sourceHasLock(src: string): boolean {
  return /FOR\s+UPDATE|\bBEGIN\b|withTransaction|SERIALIZABLE|advisory_lock|pg_advisory/i.test(src);
}
function sourceHasValidation(src: string): boolean {
  // Zod — стандарт проекта (§4 CLAUDE.md); Joi/yup — на случай легаси.
  return /\.safeParse\s*\(|\.parse\s*\(\s*(?:await\s+)?(?:req|request|body|data)|z\.object\s*\(|Joi\.object|yup\.object/i.test(src);
}
/**
 * Роут сам декларирует публичность: «AUTH: публичный» / «Public by design» в
 * шапке. Клеймо «нет авторизации» на таком файле — спор с замыслом, а не
 * находка (кейс 08.08: «утечка броней трансфера» на /api/transfers/availability,
 * где публичность заявлена комментарием и обоснована — гостевая витрина).
 */
function sourceDeclaresPublic(src: string): boolean {
  return /AUTH:\s*публичн|public\s+by\s+design|Публичный\s+эндпоинт\s+по\s+замыслу/i.test(src);
}

/**
 * Есть ли в файле хоть что-то похожее на склейку значения с SQL — то, о чём
 * вообще может идти речь в находке про инъекцию.
 *
 * Намеренно широко: любая интерполяция или конкатенация рядом с SQL-ключевым
 * словом считается «возможно есть». Задача не доказать инъекцию, а отличить
 * файл, где спор осмыслен, от файла, где склейки нет ни одной и находка
 * процитировала несуществующий код. Ложно пропустить настоящую инъекцию
 * дороже, чем пропустить одну ложную находку.
 */
function sourceHasSqlConcatenation(src: string): boolean {
  const SQL_WORD = /(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|VALUES)/i;
  // Шаблонный литерал с SQL и интерполяцией.
  for (const lit of src.match(/`[^`]*`/g) ?? []) {
    if (SQL_WORD.test(lit) && /\$\{/.test(lit)) return true;
  }
  // Обычная строка с SQL, к которой что-то приклеивают через +.
  if (/['"][^'"]*(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)[^'"]*['"]\s*\+/i.test(src)) return true;
  if (/\+\s*['"][^'"]*(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)/i.test(src)) return true;
  return false;
}

/** Номер строки, на который ссылается находка («Строка 45», «line 45:»). */
function claimedLineNumber(text: string): number | null {
  const m = /(?:строк[а-яё]*|line)\s*[№#]?\s*(\d{1,5})/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Сверяет находку «отсутствует X» с телом файла. Возвращает код причины, если
 * X в файле есть (значит находка ложна), иначе null. Консервативно: срабатывает
 * только когда находка ЯВНО про отсутствие X, а X в исходнике очевидно есть.
 */
export function verifyAgainstSource(f: CandidateFinding, source: string | null | undefined): string | null {
  if (!source) return null;
  const text = `${f.title} ${f.description} ${f.suggestion}`;
  if (claimsMissingTryCatch(text) && sourceHasTryCatch(source)) return 'source_has_try_catch';
  if (claimsMissingAuth(text) && sourceHasAuth(source)) return 'source_has_auth';
  // Не «нет auth, а auth есть», а «нет auth — и его нет НАМЕРЕННО»: роут
  // декларирует публичность в шапке. Проверяется ПОСЛЕ sourceHasAuth — файл с
  // реальной auth-логикой получает более точную причину.
  if (claimsMissingAuth(text) && sourceDeclaresPublic(source)) return 'source_declares_public';
  if (claimsMissingLock(text) && sourceHasLock(source)) return 'source_has_lock';
  // «Тело не валидируется» при живом Zod-парсинге в файле (кейс 08.08, issue
  // #1001: «data из req.json() напрямую в createBooking без проверок» — а роут
  // валидирует BookingSchema.safeParse с 29-й строки).
  if (claimsMissingValidation(text) && sourceHasValidation(source)) return 'source_has_validation';

  // Обратный класс к «нет X, когда X есть»: находка УТВЕРЖДАЕТ, что код есть, и
  // цитирует его — а кода нет. Именно так выглядели issues #768/#770/#772/#774:
  // процитированы `'SELECT * FROM bookings WHERE id = ' + bookingId` и
  // `WHERE id = ${tourId}` в файле, где весь SQL параметризован через $1.
  // Прошлые проверки такое не ловили: они спрашивают «есть ли X», а здесь надо
  // спросить «есть ли то, о чём вообще идёт речь».
  if (claimsSqlInjection(text) && !sourceHasSqlConcatenation(source)) {
    return 'source_sql_parameterized';
  }

  // Ссылка на строку за пределами файла. Дешёвый признак того, что модель
  // описывает не этот файл: в #770 фигурировала «строка 45» с одним кодом, в
  // #772 — «строка 45» с другим, в #768 — «строка 42» с третьим.
  const line = claimedLineNumber(text);
  if (line !== null && line > source.split('\n').length) return 'line_out_of_range';

  // Находка цитирует вызовы, которых в файле НЕТ ВООБЩЕ.
  //
  // Кейс #1159 (и он же #1131, и он же #1106 — одна находка, заведённая
  // трижды): «на строке 45 вызывается pool.connect(), но отсутствует блок
  // finally с client.release()». В файле нет ни pool.connect, ни release —
  // только pool.query, а строка 45 это проверка rate-limiter'а. Модель
  // описала не этот файл. Прошлые сверки такое не ловили: они спрашивают
  // «есть ли X, отсутствие которого заявлено», а здесь надо спросить, есть ли
  // хоть что-то из того, что находка ВИДЕЛА.
  //
  // Симметричная ловушка, из-за которой правило именно такое: находка ИМЕЕТ
  // ПРАВО говорить об отсутствии. #1158 верна ровно потому, что заголовка
  // X-Telegram-Bot-Api-Secret-Token в файле нет. Поэтому «символ не найден →
  // отсев» убило бы настоящие находки, и условие другое: отсев, только если
  // не найден НИ ОДИН из названных вызовов.
  //
  // Берём заголовок и описание, но НЕ suggestion: в плане правки законно
  // предлагают создать то, чего пока нет.
  const cited = citedCallSymbols(`${f.title} ${f.description}`);
  if (cited.length > 0 && !cited.some((s) => sourceMentionsSymbol(source, s))) {
    return 'source_lacks_cited_symbols';
  }

  // Инъекция названа поимённо, а названного параметра в SQL нет.
  //
  // Проверка выше спрашивает «есть ли в файле склейка SQL вообще», и этого
  // мало: запрос законно собирают из кусков, состоящих ИЗ ОДНИХ плейсхолдеров.
  // Так прошла issue #1066 про app/api/admin/audit-log — там `${cte}` и
  // `${whereClause}`, то есть SQL из `$1`, `$2`, а сам `search` уходит
  // значением параметра. Файл выглядел «со склейкой», спор — осмысленным,
  // находка — правдоподобной. Вопрос надо задавать точнее.
  if (claimsSqlInjection(text)) {
    const named = namedSqlParam(text);
    if (named && !interpolatedIntoSql(named, source)) return 'source_param_not_in_sql';
  }

  return null;
}

/**
 * Вызовы, которые находка ЦИТИРУЕТ как увиденные в файле: `pool.connect()`,
 * `client.release()`, `getServerSession()`.
 *
 * Форма нарочно узкая — только вызов или обращение к члену: `foo.bar` либо
 * `foo()`. Голые слова не берём: «finally», «POST», «search» встречаются в
 * прозе и в чужих смыслах, и по ним отсев был бы гаданием. Узкая форма значит,
 * что чаще всего список окажется пустым и проверка промолчит — это осознанно.
 * Ложный отсев настоящей находки дороже пропущенной ложной: пропущенную увидит
 * человек в Issue, отсеянная не появится нигде.
 */
export function citedCallSymbols(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const s = raw.replace(/\(\s*\)$/, '').trim();
    // Член (есть точка) или вызов (были скобки) — иначе это просто слово.
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(s) && !/\(\s*\)$/.test(raw)) return;
    if (!/^[A-Za-z_$][\w$.]*$/.test(s)) return;
    out.add(s);
  };
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\s*\)/g)) add(m[0]);
  return [...out];
}

/**
 * Есть ли символ в исходнике.
 *
 * Для `x.method` ищем ещё и `.method(`: приёмник модель нередко переименовывает
 * (`client.release` вместо `c.release`), и придираться к имени переменной
 * значило бы отсеивать находку за пересказ, а не за выдумку.
 */
export function sourceMentionsSymbol(source: string, symbol: string): boolean {
  if (source.includes(symbol)) return true;
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return false;
  return source.includes(`.${symbol.slice(dot + 1)}(`);
}

/**
 * Имя параметра, который находка обвиняет в подстановке: «Параметр search
 * вставляется…», «через `search`», «значение userId попадает в запрос».
 *
 * Возвращает только простой идентификатор латиницей — тот, который можно
 * честно поискать в исходнике. Ничего не нашлось — null, и проверка молчит.
 */
export function namedSqlParam(text: string): string | null {
  const pats = [
    /[Пп]араметр[а-яё]*\s+`?([a-z_][\w]{2,30})`?/,
    /`([a-z_][\w]{2,30})`\s+вставля/i,
    /через\s+`?([a-z_][\w]{2,30})`?\s+(?:в|into)\b/i,
  ];
  for (const p of pats) {
    const m = p.exec(text);
    // Слова-пустышки, за которыми нет идентификатора кода.
    if (m && !/^(the|this|query|запрос|value|input|user|data)$/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Попадает ли идентификатор внутрь интерполяции в SQL-литерале.
 *
 * Смотрим только на `${...}` внутри шаблонных литералов, где есть SQL-слово, и
 * на склейку через `+`. Если имени там нет ни разу — в текст запроса оно не
 * уходит, что бы находка ни утверждала. Значение параметра (`params.push(...)`)
 * под это не подпадает и правильно: `%${search}%` в аргументе — не SQL.
 */
export function interpolatedIntoSql(name: string, src: string): boolean {
  const SQL_WORD = /(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|VALUES|ILIKE|LIKE)/i;
  const ident = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const lit of src.match(/`[^`]*`/g) ?? []) {
    if (!SQL_WORD.test(lit)) continue;
    for (const expr of lit.match(/\$\{[^}]*\}/g) ?? []) {
      if (ident.test(expr)) return true;
    }
  }
  // Склейка обычных строк: '... WHERE id = ' + userId
  const concat = new RegExp(
    `['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|ILIKE|LIKE)[^'"]*['"]\\s*\\+\\s*[^;]*${name}`,
    'i',
  );
  return concat.test(src);
}
