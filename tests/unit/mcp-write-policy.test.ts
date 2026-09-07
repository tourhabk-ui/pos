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
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const {
  checkMcpWrite, CLIENT_MAX_PER_WINDOW, PHONE_MAX_PER_DAY,
} = await import('@/lib/mcp/write-guard');

const ROOT = process.cwd();
const GUARD_SRC = readFileSync(join(ROOT, 'lib/mcp/write-guard.ts'), 'utf-8');
const MIGRATION = readFileSync(join(ROOT, 'migrations/940_mcp_write_attempts.sql'), 'utf-8');
const ROUTE = readFileSync(join(ROOT, 'app/api/mcp/route.ts'), 'utf-8');
const TOOLS = readFileSync(join(ROOT, 'lib/mcp/public-tools.ts'), 'utf-8');

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
      /SELECT/.test(sql) ? Promise.resolve(counts(0, 0, 0)) : Promise.resolve({ rows: [] }));
    expect((await checkMcpWrite(base)).decision).toBe('allow');
  });

  it('счёт не удался — «не смог», а НЕ «можно»', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      /SELECT/.test(sql) ? Promise.reject(new Error('БД недоступна')) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision).toBe('unknown');
    expect(v.decision === 'unknown' && v.message).toMatch(/не удалось проверить/i);
  });

  it('соли нет — считать нечем, и это тоже «не смог»', async () => {
    delete process.env.MCP_HASH_SALT;
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const v = await checkMcpWrite(base);
      expect(v.decision).toBe('unknown');
    } finally {
      if (saved !== undefined) process.env.CRON_SECRET = saved;
    }
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
      /SELECT/.test(sql) ? Promise.resolve(counts(0, 0, PHONE_MAX_PER_DAY)) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('quarantined');
  });

  it('поток с адреса — ограничение частоты', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      /SELECT/.test(sql) ? Promise.resolve(counts(CLIENT_MAX_PER_WINDOW, 0, 0)) : Promise.resolve({ rows: [] }));
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('rate_limited');
  });

  it('отказ ЗАПИСЫВАЕТСЯ — иначе поток отказов сам себя не считает', async () => {
    const inserts: string[] = [];
    poolQueryMock.mockImplementation((sql: string) => {
      if (/INSERT/.test(sql)) { inserts.push(sql); return Promise.resolve({ rows: [] }); }
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
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    poolQueryMock.mockResolvedValue({ rows: [] });
    try {
      const v = await checkMcpWrite({ ...base, consent: false });
      expect(v.decision).toBe('deny');
      expect(v.decision === 'deny' && v.outcome).toBe('no_consent');
      expect(v.decision === 'deny' && v.message).toMatch(/consent: true/);
    } finally {
      if (saved !== undefined) process.env.CRON_SECRET = saved;
    }
  });
});
