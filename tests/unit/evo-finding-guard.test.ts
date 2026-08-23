/**
 * Страж достоверности находок Growth Scan. Фикстуры «reject» — ДОСЛОВНЫЕ
 * галлюцинации из ночных прогонов (run #255, #258). Фикстуры «pass» — реальные
 * находки, которые страж НЕ должен глушить.
 */
import { describe, it, expect } from 'vitest';
import { findingRejectionReason, isCredibleFinding, verifyAgainstSource, namedSqlParam, interpolatedIntoSql } from '@/lib/agents/evo/finding-guard';

describe('finding-guard — режет галлюцинации ночных сканов', () => {
  it('callAIFast заклеймён нарушением (run #255) → reject', () => {
    expect(findingRejectionReason({
      title: 'Прямой вызов callAIFast',
      description: 'Используется прямой вызов callAIFast вместо callAIWaterfall, нарушая конвенцию проекта.',
      suggestion: 'Заменить import { callAIFast } на import { callAIWaterfall } и вызвать callAIWaterfall',
    })).toBe('sanctioned_callaifast');
  });

  it('«callAIWaterfall вместо callAIWaterfall» (run #258) → reject как бессмыслица', () => {
    expect(findingRejectionReason({
      title: 'Использование callAIWaterfall вместо callAIWaterfall',
      description: 'В комментарии указано использование callAIWaterfall, но в коде используется callAIWaterfall — нарушение конвенции проекта',
      suggestion: 'Заменить callAIWaterfall на callAIWaterfall в соответствии с конвенцией проекта',
    })).toBe('incoherent_same_token');
  });

  it('console.error заклеймён нарушением (run #258) → reject', () => {
    expect(findingRejectionReason({
      title: 'Прямой call console.error',
      description: 'Использование console.error() в функции saveBotMemory() нарушает конвенцию проекта, где должны использоваться логгеры',
      suggestion: 'Заменить console.error() на соответствующий логгер из проекта',
    })).toBe('sanctioned_console_error');
  });
});

describe('finding-guard — НЕ глушит реальные находки', () => {
  const real = [
    {
      title: 'SQL-инъекция в фильтре',
      description: 'Конкатенация строк вместо параметров $1,$2 в WHERE — инъекция при вводе кавычки',
      suggestion: 'Заменить конкатенацию на параметризованный $1',
    },
    {
      title: 'Route без requireAuth',
      description: 'Защищённый POST не вызывает requireAuth — обход авторизации',
      suggestion: 'Добавить requireAuth в начало обработчика',
    },
    {
      title: 'console.log в проде',
      description: 'Отладочный console.log в обработчике брони попадает в прод-логи',
      suggestion: 'Убрать console.log или заменить на console.error в catch',
    },
    {
      title: 'Прямой callDeepSeek',
      description: 'Прямой вызов callDeepSeek вместо callAIWaterfall в обход waterfall',
      suggestion: 'Заменить callDeepSeek на callAIWaterfall',
    },
    {
      title: 'callAIFast без try/catch',
      description: 'Внешний вызов callAIFast не обёрнут в try/catch — падение при сбое провайдера',
      suggestion: 'Обернуть вызов в try/catch',
    },
  ];

  it('все реальные находки проходят страж', () => {
    for (const f of real) {
      expect(isCredibleFinding(f), `ложно отклонена: ${f.title}`).toBe(true);
    }
  });

  it('callAIFast без конвенционного клейма (только try/catch) — проходит', () => {
    expect(findingRejectionReason({
      title: 'callAIFast без try/catch',
      description: 'Внешний вызов callAIFast не обёрнут в try/catch',
      suggestion: 'Добавить try/catch',
    })).toBeNull();
  });
});

describe('finding-guard — чужой стек (Prisma/NextAuth) = галлюцинация', () => {
  it('«оберни в Prisma-транзакцию» (booking-роут #738) → reject', () => {
    expect(findingRejectionReason({
      title: 'Race condition: concurrent booking creation',
      description: 'No locking prevents overselling. Two requests pass availability check.',
      suggestion: 'Обернуть проверку и создание в Prisma-транзакцию с SELECT ... FOR UPDATE',
    })).toBe('foreign_stack');
  });

  it('«добавь getServerSession» (booking-роут #737) → reject', () => {
    expect(findingRejectionReason({
      title: 'No authentication check visible',
      description: 'Route accepts requests without verifying identity.',
      suggestion: 'Получить сессию через getServerSession и вернуть 401 при отсутствии',
    })).toBe('foreign_stack');
  });
});

describe('finding-guard — верификационный проход по телу файла', () => {
  // Фрагмент booking-роута: JWT-auth + try/catch + FOR UPDATE (реальный код).
  const bookingSrc = `
    import { verifyToken, extractToken } from '@/lib/auth/jwt';
    export async function POST(req) {
      const token = extractToken(req);
      const authedUser = token ? await verifyToken(token) : null;
      try {
        const tour = await client.query('SELECT ... FOR UPDATE', [id]);
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json({ error: 'fail' }, { status: 500 });
      }
    }`;

  it('«нет try/catch», а он есть → source_has_try_catch', () => {
    expect(verifyAgainstSource({
      title: 'Missing Error Handling',
      description: 'createBooking is not wrapped in a try/catch block, unhandled exception crashes server.',
      suggestion: 'Обернуть вызов в try/catch',
    }, bookingSrc)).toBe('source_has_try_catch');
  });

  it('«нет авторизации, userId из body», а JWT есть → source_has_auth', () => {
    expect(verifyAgainstSource({
      title: 'No authorization check',
      description: 'userId from request body is not validated against session. User can create bookings for others.',
      suggestion: 'Брать userId из проверенной сессии',
    }, bookingSrc)).toBe('source_has_auth');
  });

  it('«race condition без блокировки», а FOR UPDATE есть → source_has_lock', () => {
    expect(verifyAgainstSource({
      title: 'Race condition in concurrent booking',
      description: 'No pessimistic locking before INSERT, concurrent requests oversell slots.',
      suggestion: 'Добавить SELECT ... FOR UPDATE',
    }, bookingSrc)).toBe('source_has_lock');
  });

  it('реальная находка «нет try/catch» на файле БЕЗ него — НЕ отклоняется', () => {
    const noGuard = `export async function POST(req){ const b = await req.json(); return doThing(b); }`;
    expect(verifyAgainstSource({
      title: 'Missing try/catch',
      description: 'External call not wrapped in try/catch',
      suggestion: 'Add try/catch',
    }, noGuard)).toBeNull();
  });

  it('нет исходника → null (нечего сверять)', () => {
    expect(verifyAgainstSource({ title: 'x', description: 'no try/catch', suggestion: 'y' }, null)).toBeNull();
  });
});

/**
 * Класс, обратный «нет X, когда X есть»: находка УТВЕРЖДАЕТ наличие кода и
 * цитирует его — а кода нет.
 *
 * Не гипотеза: 28.07 я сверил все пятнадцать critical-issues Growth Scan с
 * реальным файлом app/api/hub/bookings/create/route.ts. Четыре из них
 * (#768, #770, #772, #774) процитировали конкатенацию SQL, которой в файле нет
 * ни одной — весь SQL параметризован через $1. Одна (#776) заклеймила запрос
 * непараметризованным и тут же процитировала `WHERE telegram_chat_id = $1`,
 * то есть саму параметризацию.
 *
 * Прежние проверки этого не ловили: они спрашивают «есть ли X в файле», а надо
 * спросить «существует ли вообще то, о чём говорит находка».
 */
describe('находка цитирует код, которого в файле нет', () => {
  // Форма реального файла: параметризованный SQL, без единой склейки.
  const parameterized = `
    const r = await client.query(
      \`SELECT ot.id, ot.operator_id FROM operator_tours ot
        WHERE ot.id = $1 AND ot.is_active = true FOR UPDATE\`,
      [data.tour_id],
    );
    await client.query('INSERT INTO operator_bookings (operator_tour_id) VALUES ($1)', [id]);
  `;

  it('«SQL-инъекция» в файле без склейки → source_sql_parameterized', () => {
    expect(verifyAgainstSource({
      title: 'SQL-инъекция в запросе бронирования',
      description: "Строка 45: конкатенация 'SELECT * FROM bookings WHERE id = ' + bookingId вместо параметризованного запроса.",
      suggestion: 'Заменить конкатенацию на параметризованный запрос',
    }, parameterized)).toBe('source_sql_parameterized');
  });

  it('настоящая склейка в файле — находка НЕ отклоняется', () => {
    const vulnerable = 'const sql = `SELECT * FROM bookings WHERE id = ${bookingId}`; await pool.query(sql);';
    expect(verifyAgainstSource({
      title: 'SQL-инъекция',
      description: 'Конкатенация в SQL вместо параметризации',
      suggestion: 'Использовать $1',
    }, vulnerable)).toBeNull();
  });

  it('склейка через + тоже считается настоящей', () => {
    const vulnerable = "const sql = 'SELECT * FROM bookings WHERE id = ' + bookingId;";
    expect(verifyAgainstSource({
      title: 'SQL-инъекция',
      description: 'непараметризованный запрос',
      suggestion: 'параметризовать',
    }, vulnerable)).toBeNull();
  });

  it('ссылка на строку за пределами файла → line_out_of_range', () => {
    const short = 'export async function POST() {\n  return new Response();\n}';
    expect(verifyAgainstSource({
      title: 'Проблема',
      description: 'Строка 45: тут что-то не так с логикой',
      suggestion: 'Починить',
    }, short)).toBe('line_out_of_range');
  });

  it('ссылка на существующую строку не мешает находке пройти', () => {
    const long = Array.from({ length: 60 }, (_, i) => `const x${i} = ${i};`).join('\n');
    expect(verifyAgainstSource({
      title: 'Проблема',
      description: 'Строка 45: тут что-то не так',
      suggestion: 'Починить',
    }, long)).toBeNull();
  });
});

describe('находка опровергает сама себя', () => {
  it('клеймит «без параметризации» и цитирует $1 → quotes_placeholder_as_unsafe', () => {
    // Дословно issue #776 по lib/kuzmich/core.ts.
    expect(isCredibleFinding({
      title: 'SQL-инъекция в pool.query',
      description: 'SQL-запрос к таблице leads использует параметр напрямую в строке запроса без параметризации: WHERE telegram_chat_id = $1.',
      suggestion: 'Параметризовать запрос',
    })).toBe(false);
  });

  it('находка про инъекцию БЕЗ плейсхолдера в тексте проходит content-free слой', () => {
    // Сверка с файлом — дело verifyAgainstSource, здесь глушить нечего.
    expect(isCredibleFinding({
      title: 'SQL-инъекция',
      description: "Конкатенация 'WHERE id = ' + userId в запросе",
      suggestion: 'Параметризовать',
    })).toBe(true);
  });
});

describe('клеймо «нет валидации» при живом Zod в файле (кейс 08.08, #1001)', () => {
  const BOOKING_SRC = `
import { z } from 'zod';
const BookingSchema = z.object({ tour_id: z.number().positive() });
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return err400(); }
  const parsed = BookingSchema.safeParse(body);
  if (!parsed.success) return err400();
  return createBooking(parsed.data);
}`;

  it('дословный текст issue #1001 глушится по source_has_validation', () => {
    expect(verifyAgainstSource({
      title: 'Missing Validation (high)',
      description: 'The request body is not validated before being used. This could lead to unexpected errors or security vulnerabilities if the data is malformed or malicious. Specifically, the data object from req.json() is directly passed to createBooking without any checks.',
      suggestion: 'Внедрить схему валидации входящих данных перед передачей в createBooking, используя Zod или Joi.',
    }, BOOKING_SRC)).toBe('source_has_validation');
  });

  it('«нет валидации» на файле БЕЗ парсинга схемы — проходит (может быть правдой)', () => {
    expect(verifyAgainstSource({
      title: 'Нет валидации',
      description: 'Тело запроса не проверяется перед использованием',
      suggestion: 'Добавить Zod-схему',
    }, 'export async function POST(req){ const d = await req.json(); return save(d); }')).toBeNull();
  });
});

describe('клеймо «нет авторизации» у роута, публичного по замыслу (кейс 08.08)', () => {
  const TRANSFERS_SRC = `
/**
 * GET /api/transfers/availability
 * Проверка доступности трансферов на дату
 * AUTH: публичный — guest может проверять доступность слотов без авторизации.
 */
export async function GET(request: NextRequest) {
  const bookingsResult = await query('SELECT COUNT(*) FROM transfer_bookings WHERE pickup_date = $1', [date]);
  return NextResponse.json({ slots });
}`;

  it('«эндпоинт без авторизации раскрывает данные» глушится по source_declares_public', () => {
    expect(verifyAgainstSource({
      title: 'Утечка данных броней трансфера',
      description: 'Публичный эндпоинт без авторизации выполняет COUNT по transfer_bookings — раскрытие коммерческой информации оператора без аутентификации.',
      suggestion: 'Добавить requireAuth/requireTransferOperator перед запросом.',
    }, TRANSFERS_SRC)).toBe('source_declares_public');
  });

  it('английская декларация Public by design тоже распознаётся', () => {
    expect(verifyAgainstSource({
      title: 'No auth on endpoint',
      description: 'Endpoint is unauthenticated and leaks data',
      suggestion: 'Add requireAuth',
    }, '// Public by design: slot selection for booking flow.\nexport async function GET(){}')).toBe('source_declares_public');
  });

  it('«нет авторизации» на роуте без декларации и без auth — проходит (может быть правдой)', () => {
    expect(verifyAgainstSource({
      title: 'Нет авторизации',
      description: 'Роут отдаёт данные без проверки прав',
      suggestion: 'Добавить requireAuth',
    }, 'export async function GET(){ return NextResponse.json(await query("SELECT * FROM x")); }')).toBeNull();
  });

  it('файл с реальной auth-логикой получает более точную причину source_has_auth', () => {
    expect(verifyAgainstSource({
      title: 'Нет авторизации',
      description: 'Роут без проверки прав, no auth',
      suggestion: 'Добавить requireAuth',
    }, '// AUTH: публичный — но есть и опциональная auth\nconst u = await getUserFromRequest(req);')).toBe('source_has_auth');
  });
});

/**
 * Два класса, прошедшие наружу в Issues 08–09.08 и разобранные вручную 10.08.
 * Оба — про то, что сбой сканирования выглядел как результат сканирования.
 */
describe('находки, прошедшие в Issues 08-09.08', () => {
  /**
   * Issue #1066 «SQL-инъекция через search в ILIKE (critical)».
   *
   * Файл собирает запрос из кусков — `${cte}`, `${whereClause}`, — но куски
   * состоят из одних плейсхолдеров, а сам `search` уходит ЗНАЧЕНИЕМ параметра.
   * Прежняя проверка спрашивала «есть ли в файле склейка SQL вообще», видела
   * интерполяцию рядом с SELECT и пропускала находку как осмысленный спор.
   */
  const AUDIT_LOG_SRC = `
    const params: (string | number)[] = [];
    let paramIdx = 1;
    let searchFilter = '';
    if (search) {
      searchFilter += \` (action ILIKE $\${paramIdx} OR COALESCE(user_email, '') ILIKE $\${paramIdx})\`;
      params.push(\`%\${search}%\`);
      paramIdx++;
    }
    const rows = await query(\`\${cte} SELECT * FROM unified\${whereClause} ORDER BY created_at DESC\`, params);
  `;

  const INJECTION_FINDING = {
    title: 'SQL-инъекция через search в ILIKE',
    description: 'Параметр search вставляется в ILIKE-условие через конкатенацию строк, а не через параметр.',
    suggestion: 'Заменить конкатенацию на параметризованный запрос: WHERE column ILIKE $1.',
  };

  it('названный параметр в SQL не интерполируется — находка ложна', () => {
    expect(verifyAgainstSource(INJECTION_FINDING, AUDIT_LOG_SRC)).toBe('source_param_not_in_sql');
  });

  it('имя параметра вычитывается из текста находки', () => {
    expect(namedSqlParam(INJECTION_FINDING.description)).toBe('search');
    // Слова-пустышки за идентификатор не принимаются.
    expect(namedSqlParam('Параметр запрос вставляется в SQL')).toBeNull();
  });

  it('значение параметра — не SQL: %${search}% в params.push не считается', () => {
    expect(interpolatedIntoSql('search', AUDIT_LOG_SRC)).toBe(false);
  });

  it('настоящая инъекция проходит: имя стоит внутри текста запроса', () => {
    const REAL = 'const r = await query(`SELECT * FROM users WHERE email = \'${search}\'`);';
    expect(interpolatedIntoSql('search', REAL)).toBe(true);
    expect(verifyAgainstSource(INJECTION_FINDING, REAL)).toBeNull();
  });

  it('склейка через плюс тоже считается настоящей', () => {
    const REAL = "const sql = 'SELECT * FROM users WHERE id = ' + search;";
    expect(interpolatedIntoSql('search', REAL)).toBe(true);
  });

  /** Issue #1020 «Содержимое файлов не передано (high)». */
  it('жалоба модели на непереданный код — дефект прогона, не находка', () => {
    expect(findingRejectionReason({
      title: 'Содержимое файлов не передано',
      description: 'В запросе указаны только пути к файлам, но сам код не приложен. Без содержимого файлов невозможно провести анализ — любые выводы были бы выдумкой.',
      suggestion: 'Необходимо запросить у пользователя полный код указанных файлов.',
    })).toBe('scan_input_missing');
  });

  it('английский вариант той же жалобы', () => {
    expect(findingRejectionReason({
      title: 'Cannot analyze',
      description: 'File contents were not provided, only paths.',
      suggestion: 'Please provide the full source.',
    })).toBe('scan_input_missing');
  });

  it('находка, которая просто УПОМИНАЕТ файлы, не глушится', () => {
    expect(findingRejectionReason({
      title: 'Нет обработки ошибок',
      description: 'В файле route.ts внешний вызов не обёрнут в try/catch.',
      suggestion: 'Обернуть fetch в try/catch и логировать ошибку.',
    })).toBeNull();
  });
});

describe('инъекция, которой нет (прогон 23.08)', () => {
  /**
   * Прочёс 23.08 выдал три находки подряд с одинаковым заголовком
   * «SQL-инъекция через конкатенацию»: legacy-tours-census, partner.service,
   * review.service. Все три проверены чтением кода и оказались ложными.
   *
   *  - В переписи имена колонок берутся из information_schema и ПЕРЕСЕКАЮТСЯ
   *    с литеральным списком WANTED_COLUMNS: снаружи в текст запроса не
   *    попадает ничего.
   *  - В partner.service и review.service склейкой строится НОМЕР
   *    плейсхолдера (`$${values.length + 1}`), а значение уходит в массив.
   *    Это и есть параметризация, а не обход её.
   *
   * Обсуждать стиль можно, но не под именем уязвимости: клеймо «инъекция» на
   * параметризованном коде обесценивает очередь — настоящую инъекцию
   * перестают читать среди ложных.
   */
  const inj = (description: string) => ({
    title: 'SQL-инъекция через конкатенацию',
    description,
    suggestion: '',
  });

  it('построение номера плейсхолдера не считается инъекцией', () => {
    const f = inj('В list() используется конкатенация `type = $${values.length + 1}` и `verified = TRUE` — хотя значения параметризованы, условие `verified = TRUE` захардкожено, но конкатенация в SQL — плохая практика.');
    expect(findingRejectionReason(f)).toBe('quotes_placeholder_as_unsafe');
  });

  it('находка, сама признающая, что риск будущий, отсеивается', () => {
    const f = inj('Хотя значения берутся из WANTED_COLUMNS (захардкожены), конкатенация в SQL — плохая практика, потенциальная инъекция при изменении кода.');
    expect(findingRejectionReason(f)).toBe('admits_risk_is_hypothetical');
  });

  it('настоящая инъекция по-прежнему проходит', () => {
    // Отрицательный контроль: правило, отсеивающее всё подряд, хуже его
    // отсутствия — оно молчит там, где надо кричать.
    const f = inj('Параметр sort из query подставляется в ORDER BY через конкатенацию строк без параметризации: `ORDER BY ${sort}`. Злоумышленник передаёт произвольный SQL.');
    expect(findingRejectionReason(f)).toBeNull();
  });
});
