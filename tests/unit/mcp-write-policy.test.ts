// @vitest-environment node
/**
 * Policy v3 публичного MCP: чем удерживается анонимная запись ПД.
 *
 * До 07.09 её удерживал счётчик в памяти процесса (`lib/rate-limit.ts`,
 * `new Map`). Он обнуляется на каждом рестарте контейнера и не существует
 * между инстансами — то есть ограничение выглядело защитой, ею не будучи.
 * Плюс MCP не записывал согласие на обработку ПД вообще: `buildConsentRecord`
 * честно возвращал null («не спрашивали»), и как факт это было верно, а как
 * позиция для анонимного приёма чужого телефона — нет.
 *
 * Сторож держит четыре свойства:
 *   1. три исхода, и «не смог» НЕ равен «можно»;
 *   2. без согласия записи нет, и отказ объясняет, что сделать;
 *   3. в журнале нет персональных данных — только отпечатки с солью;
 *   4. согласие доезжает до лида обоими заявочными путями.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
// Решение считается и записывается ОДНОЙ транзакцией под advisory-замком
// (гонка карантина, 07.09), поэтому мок обязан уметь connect: клиент
// транзакции и есть то место, где теперь идёт счёт.
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => poolQueryMock(...args),
    connect: async () => ({
      query: (...args: unknown[]) => poolQueryMock(...args),
      release: () => {},
    }),
  },
}));

/** Транзакционные команды и замок мок пропускает молча. */
function txNoise(sql: string): boolean {
  return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql);
}

const {
  checkMcpWrite, CLIENT_MAX_PER_WINDOW, PHONE_MAX_PER_DAY,
} = await import('@/lib/mcp/write-guard');

const ROOT = process.cwd();
const GUARD_SRC = readFileSync(join(ROOT, 'lib/mcp/write-guard.ts'), 'utf-8');
const MIGRATION = readFileSync(join(ROOT, 'migrations/940_mcp_write_attempts.sql'), 'utf-8');
const ROUTE = readFileSync(join(ROOT, 'app/api/mcp/route.ts'), 'utf-8');
const TOOLS = readFileSync(join(ROOT, 'lib/mcp/public-tools.ts'), 'utf-8');
const HEALTH = readFileSync(join(ROOT, 'app/api/cron/health/route.ts'), 'utf-8');

const base = {
  ip: '203.0.113.7', userAgent: 'agent/1.0',
  tool: 'create_lead', phone: '+79001234567', consent: true,
};

/** Ответ счётчика: одна строка с тремя числами в виде текста. */
function counts(a: number, b: number, c: number) {
  return { rows: [{ a: String(a), b: String(b), c: String(c) }] };
}

beforeEach(() => {
  poolQueryMock.mockReset();
  process.env.MCP_HASH_SALT = 'соль-для-теста';
});

describe('три исхода, и третий не равен первому', () => {
  it('чисто — пускаем', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      !txNoise(sql) && /COUNT\(\*\)/.test(sql) ? Promise.resolve(counts(0, 0, 0)) : Promise.resolve({ rows: [] }));
    expect((await checkMcpWrite(base)).decision).toBe('allow');
  });

  it('счёт не удался — «не смог», а НЕ «можно»', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      !txNoise(sql) && /COUNT\(\*\)/.test(sql) ? Promise.reject(new Error('БД недоступна')) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision).toBe('unknown');
    expect(v.decision === 'unknown' && v.message).toMatch(/не удалось проверить/i);
  });

  it('соли нет — считать нечем, и это тоже «не смог»', async () => {
    // CRON_SECRET намеренно ОСТАВЛЕН заданным: с 07.09 откат на него убран, и
    // проверяется именно это — своя переменная стала единственным источником.
    delete process.env.MCP_HASH_SALT;
    process.env.CRON_SECRET = 'секрет-крона-который-НЕ-должен-подойти';
    const v = await checkMcpWrite(base);
    expect(v.decision).toBe('unknown');
  });

  it('CRON_SECRET солью больше не работает — откат убран', () => {
    expect(
      GUARD_SRC,
      'откат на CRON_SECRET вернулся: общий секрет связывает поворот крона с окном лимита',
    ).not.toMatch(/MCP_HASH_SALT\s*\|\|\s*process\.env\.CRON_SECRET/);
  });
});

describe('согласие спрашивается и объясняется', () => {
  it('без согласия — отказ с указанием, что сделать', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const v = await checkMcpWrite({ ...base, consent: false });
    expect(v.decision).toBe('deny');
    expect(v.decision === 'deny' && v.outcome).toBe('no_consent');
    expect(v.decision === 'deny' && v.message).toMatch(/consent: true/);
  });

  it('отказ по согласию не зависит от базы — он детерминирован', async () => {
    poolQueryMock.mockRejectedValue(new Error('БД недоступна'));
    const v = await checkMcpWrite({ ...base, consent: false });
    // Упавшая база не должна подменять основание отказа на «не смог»:
    // согласия не было, и это известно без всякого счёта.
    expect(v.decision).toBe('deny');
  });

  it('оба заявочных инструмента ТРЕБУЮТ consent в схеме', () => {
    const required = [...TOOLS.matchAll(/required:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(required.length).toBe(2);
    for (const r of required) expect(r).toContain("'consent'");
  });
});

describe('потоки останавливаются', () => {
  it('повтор телефона — карантин', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      !txNoise(sql) && /COUNT\(\*\)/.test(sql) ? Promise.resolve(counts(0, 0, PHONE_MAX_PER_DAY)) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('quarantined');
  });

  it('поток с адреса — ограничение частоты', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      !txNoise(sql) && /COUNT\(\*\)/.test(sql) ? Promise.resolve(counts(CLIENT_MAX_PER_WINDOW, 0, 0)) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('rate_limited');
  });

  it('отказ ЗАПИСЫВАЕТСЯ — иначе поток отказов сам себя не считает', async () => {
    const inserts: string[] = [];
    poolQueryMock.mockImplementation((sql: string) => {
      if (/INSERT/.test(sql)) { inserts.push(sql); return Promise.resolve({ rows: [] }); }
      if (txNoise(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve(counts(CLIENT_MAX_PER_WINDOW, 0, 0));
    });
    await checkMcpWrite(base);
    expect(inserts.length).toBe(1);
  });
});

describe('в журнале нет персональных данных', () => {
  it('таблица не заводит колонок под телефон, имя и адрес', () => {
    for (const forbidden of ['phone ', 'phone_number', 'name ', 'ip ', 'ip_address', 'email']) {
      expect(MIGRATION.toLowerCase(), `колонка ${forbidden} хранила бы ПД`).not.toContain(`\n  ${forbidden}`);
    }
    expect(MIGRATION).toContain('phone_hash');
    expect(MIGRATION).toContain('client_key');
  });

  it('в INSERT уходят только отпечатки', () => {
    const insert = GUARD_SRC.slice(GUARD_SRC.indexOf('INSERT INTO mcp_write_attempts'));
    expect(insert).toContain('clientKey');
    expect(insert).toContain('phoneHash');
    expect(insert, 'сырой телефон в журнале').not.toMatch(/\binput\.phone\b/);
    expect(insert, 'сырой адрес в журнале').not.toMatch(/\binput\.ip\b/);
  });

  it('отпечаток солится — голый sha256 адреса перебирается за секунды', () => {
    expect(GUARD_SRC).toMatch(/createHash\('sha256'\)\.update\(`\$\{s\}:/);
  });
});

describe('согласие доезжает до лида обоими путями', () => {
  it('оба createLead из MCP получают pd_consent', () => {
    const calls = [...ROUTE.matchAll(/createLead\(\{[\s\S]*?\n  \}\)/g)].map((m) => m[0]);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toContain('pd_consent');
  });

  it('источник согласия назван «mcp», а не подставлен от формы сайта', () => {
    expect(ROUTE).toMatch(/buildConsentRecord\(true,\s*ctx\.ip,\s*'mcp'\)/);
  });

  it('интервал параметризован, а не склеен строкой', () => {
    expect(GUARD_SRC).not.toMatch(/INTERVAL\s*'[^']*\$\{/);
    expect(GUARD_SRC).toContain("INTERVAL '1 minute' * $3::int");
  });
});

/**
 * Порядок проверок — не косметика (найдено собственным прогоном 07.09).
 *
 * В первой редакции проверка соли стояла выше согласия, и в среде без соли
 * отказ «нет согласия» подменялся ответом «не смог посчитать поток». Агенту
 * сообщали про НАШУ конфигурацию вместо того, что требуется от него, — он
 * чинил бы не то и повторял запрос, который не пройдёт никогда.
 */
describe('основание отказа настоящее, а не первое попавшееся', () => {
  it('без соли и без согласия отказ всё равно ПО СОГЛАСИЮ', async () => {
    delete process.env.MCP_HASH_SALT;
    poolQueryMock.mockResolvedValue({ rows: [] });
    const v = await checkMcpWrite({ ...base, consent: false });
    expect(v.decision).toBe('deny');
    expect(v.decision === 'deny' && v.outcome).toBe('no_consent');
    expect(v.decision === 'deny' && v.message).toMatch(/consent: true/);
  });
});

/**
 * Гонка на карантине (найдено внешним ревью 07.09).
 *
 * Первая редакция считала одним запросом, а писала следующим — то самое
 * check-then-act, которое в этом репозитории уже чинили дважды
 * (`recordPrEventOnce`, `idempotencyKey` у code-merge-task). Три
 * параллельных `create_lead` с одним телефоном успевали посчитать ДО того,
 * как хоть одна строка коммитилась, и все три видели ноль. Лимит «после
 * факта» на параллели не работает, а поток именно так и выглядит.
 *
 * Свойство проверяется по форме, а не по поведению: гонку в юните не
 * воспроизвести — она про изоляцию транзакций настоящего PostgreSQL.
 * Поэтому здесь держится то, чем гонка закрыта.
 */
describe('счёт и запись — одна транзакция под замком', () => {
  it('решение считается на клиенте транзакции, а не на пуле', async () => {
    const seen: string[] = [];
    poolQueryMock.mockImplementation((sql: string) => {
      seen.push(sql.trim().split('\n')[0]);
      if (txNoise(sql)) return Promise.resolve({ rows: [] });
      if (/COUNT\(\*\)/.test(sql)) return Promise.resolve(counts(0, 0, 0));
      return Promise.resolve({ rows: [] });
    });
    await checkMcpWrite(base);
    expect(seen[0]).toBe('BEGIN');
    expect(seen.some((q) => /pg_advisory_xact_lock/.test(q)), 'замок не взят').toBe(true);
    expect(seen.includes('COMMIT'), 'транзакция не закрыта').toBe(true);
    // Счёт и вставка обязаны стоять МЕЖДУ BEGIN и COMMIT.
    const begin = seen.indexOf('BEGIN');
    const commit = seen.indexOf('COMMIT');
    const insert = seen.findIndex((q) => /INSERT INTO mcp_write_attempts/.test(q));
    expect(insert).toBeGreaterThan(begin);
    expect(insert).toBeLessThan(commit);
  });

  it('замки берутся в детерминированном порядке — иначе взаимная блокировка', () => {
    // Два клиента с одним телефоном берут одни и те же два замка; без общего
    // порядка это классический deadlock.
    expect(GUARD_SRC).toMatch(/locks\.sort\(/);
    expect(GUARD_SRC).toContain('LOCK_NS_CLIENT');
    expect(GUARD_SRC).toContain('LOCK_NS_PHONE');
  });

  it('на ошибке — откат, а не полузаписанное состояние', () => {
    const tx = GUARD_SRC.slice(GUARD_SRC.indexOf('await client.query(\'BEGIN\')'));
    expect(tx).toContain("ROLLBACK");
    expect(tx).toContain('client.release()');
  });
});

describe('долг по согласию назван долгом', () => {
  /**
   * `consent: true` ставит агент, а не человек. Запись честно значит «агент
   * утверждает, что согласие получено», и не значит «человек поставил
   * галочку». Пункт закрыт наполовину, и в коде это должно быть написано —
   * иначе через месяц он будет числиться закрытым целиком.
   */
  it('в модуле сказано, что согласие ставит агент, и назван мост', () => {
    expect(GUARD_SRC).toMatch(/ставит АГЕНТ, а не человек/);
    expect(GUARD_SRC).toContain('issueMcpHandoff');
    expect(GUARD_SRC).toMatch(/закрыт НАПОЛОВИНУ/);
  });
});


/**
 * Наличие соли видно снаружи, значение — никогда.
 *
 * Убрать откат на CRON_SECRET можно только по факту, что своя соль доехала до
 * контейнера. Отличить одно от другого снаружи иначе нечем, а снять откат
 * вслепую значит остановить запись, если переменная не доехала.
 */
describe('диагностика соли: имя и булево, не значение', () => {
  it('health сообщает НАЛИЧИЕ соли', () => {
    expect(HEALTH).toMatch(/mcp_hash_salt:\s*!!process\.env\.MCP_HASH_SALT/);
  });

  it('само ЗНАЧЕНИЕ соли не читается нигде, кроме её чтения', () => {
    // Проверяется употребление значения, а не упоминание имени: имя
    // переменной в тексте отказа — подсказка человеку, что настроить, и
    // раскрыть соль она не может. Раскрывает — интерполяция значения.
    const ALLOWED = [
      /!!process\.env\.MCP_HASH_SALT/,                                   // булево наличия
      /process\.env\.MCP_HASH_SALT \|\| null/,                            // единственное чтение
    ];
    for (const [name, src] of [['health', HEALTH], ['write-guard', GUARD_SRC]] as const) {
      const uses = src
        .split('\n')
        .filter((l) => /process\.env\.MCP_HASH_SALT/.test(l))
        .filter((l) => !ALLOWED.some((re) => re.test(l)));
      expect(uses, `${name}: значение соли читается вне разрешённых мест: ${uses.join(' | ')}`).toEqual([]);
    }
  });

  it('соль не интерполируется в вывод', () => {
    // `${s}` внутри hash — единственное законное употребление; в шаблон
    // сообщения или лога значение попадать не должно.
    const emitted = GUARD_SRC
      .split('\n')
      .filter((l) => /console\.|message:/.test(l))
      .filter((l) => /\$\{s\}/.test(l));
    expect(emitted, `соль в выводе: ${emitted.join(' | ')}`).toEqual([]);
  });
});
