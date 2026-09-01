/**
 * Перепись списка #1304 обязана различать «нет» и «не смогли спросить».
 *
 * ── Что стережём ───────────────────────────────────────────────────────────
 *
 * Список «таблиц вне реестра схемы» — признание незнания, а не диагноз. Разбор
 * 31.08 показал, что за одним пунктом стоят разные беды с разными способами
 * закрытия: `transfer_bookings` на проде НЕТ вовсе (Watchdog получил 42P01, и
 * пятнадцать читающих её файлов мертвы), а `operators` почти наверняка есть —
 * её читают 73 файла и кабинет оператора работает.
 *
 * Перепись эту разницу и должна показать. Значит её главный риск — не ошибка в
 * счёте, а СЛИЯНИЕ исходов: если отказ запроса вернёт пустой список или нули,
 * читающий примет «мы не дозвонились» за «таблиц нет» и удалит живой код. Это
 * ровно тот дефект §4.0, ради которого перепись и заводится.
 *
 * Поэтому оба пути доказываются ИСПОЛНЕНИЕМ роута с подставной базой, а не
 * чтением его текста: текстовый сторож подтвердил бы наличие слова `unknown`,
 * ничего не сказав о том, попадает ли оно в ответ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNDECLARED_TABLES, CANARY_TABLES, SUSPECT_DECLARED_TABLES } from '@/lib/db/undeclared-registry';

const query = vi.fn();

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/security/timing-safe', () => ({ timingSafeCompare: () => true }));
vi.mock('@/lib/auth/cron', () => ({
  getCronSecret: () => 'secret',
  diagnoseCronAuth: () => ({}),
}));

const ROUTE_SRC = join(process.cwd(), 'app/api/cron/schema-registry-census/route.ts');

/** Ответ роута как объект. Запрос фиктивный: авторизация замокана целиком. */
async function callRoute() {
  const { GET } = await import('@/app/api/cron/schema-registry-census/route');
  const res = await GET({ headers: new Headers() } as never);
  return (await res.json()) as {
    success: boolean;
    contract_version: number;
    verdict: string;
    counts: Record<string, number>;
    canary: { expected: readonly string[]; missing: string[]; ok: boolean } | null;
    connection: Record<string, string | null> | null;
    suspect_declared: Array<{ table: string; present: boolean; alive: boolean }> | null;
    tables: Array<{ table: string; state: string; reason?: string; columns: unknown[] }>;
  };
}

/**
 * Ответ подставной базы: канарейка видна, плюс что попросили сверх неё.
 *
 * Без канарейки перепись обязана отказываться судить, поэтому почти каждый
 * сценарий начинается с неё — иначе тесты проверяли бы недостижимую ветку.
 */
function withCanary(extra: Array<{ table_name: string; any_row: string }>) {
  return [...CANARY_TABLES.map((t) => ({ table_name: t, any_row: '1' })), ...extra];
}

beforeEach(() => {
  query.mockReset();
  process.env.CRON_SECRET = 'secret';
});

describe('перепись реестра схемы: исходы не сливаются', () => {
  it('живая, пустая и отсутствующая таблицы получают РАЗНЫЕ состояния', async () => {
    const [alive, empty] = UNDECLARED_TABLES;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ db_user: 'app', schema: 'public' }] };
      if (sql.includes('query_to_xml')) {
        return {
          rows: withCanary([
            { table_name: alive, any_row: '1' },
            { table_name: empty, any_row: '0' },
          ]),
        };
      }
      return {
        rows: [
          { table_name: alive, column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
        ],
      };
    });

    const body = await callRoute();
    const state = (t: string) => body.tables.find((r) => r.table === t)?.state;

    expect(state(alive)).toBe('present_with_rows');
    expect(state(empty)).toBe('present_empty');
    // Всё, чего не вернул information_schema, на проде отсутствует — это факт,
    // а не догадка: спрашивали разом про весь список одним запросом.
    expect(state(UNDECLARED_TABLES[2])).toBe('absent');

    expect(body.counts.total).toBe(UNDECLARED_TABLES.length);
    expect(body.counts.present_with_rows).toBe(1);
    expect(body.counts.present_empty).toBe(1);
    expect(body.counts.absent).toBe(UNDECLARED_TABLES.length - 2);
    expect(body.counts.unknown).toBe(0);

    // Колонки нужны как материал для захвата DDL — без них ответ бесполезен
    // именно там, где пункт закрывается миграцией.
    expect(body.tables.find((r) => r.table === alive)?.columns).toEqual([
      { name: 'id', type: 'uuid', nullable: false },
    ]);
  });

  it('отказ базы делает ВЕСЬ список unknown, а не пустым и не absent', async () => {
    query.mockRejectedValue(Object.assign(new Error('connection refused'), { code: '08006' }));

    const body = await callRoute();

    expect(body.counts.unknown).toBe(UNDECLARED_TABLES.length);
    expect(body.counts.absent, '«не дозвонились» не равно «таблицы нет»').toBe(0);
    expect(body.tables.every((r) => r.state === 'unknown')).toBe(true);
    // Причина обязана дойти до читающего: без SQLSTATE отказ соединения
    // неотличим от 42P01, а починка у них разная.
    expect(body.tables[0].reason).toContain('08006');
    expect(body.verdict).toContain('НЕ СМОГЛИ ПРОВЕРИТЬ');
    expect(body.success).toBe(false);
  });

  it('вердикт словами называет обе группы поимённо', async () => {
    const [absentOne, aliveOne] = UNDECLARED_TABLES;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ db_user: 'app', schema: 'public' }] };
      return sql.includes('query_to_xml')
        ? { rows: withCanary([{ table_name: aliveOne, any_row: '1' }]) }
        : { rows: [] };
    });

    const body = await callRoute();
    // Раскладка по числам не говорит, что делать дальше: удалять код или
    // захватывать DDL — решается по именам, и они должны быть в вердикте.
    expect(body.verdict).toContain(aliveOne);
    expect(body.verdict).toContain(absentOne);
  });
});

describe('канарейка: перепись отказывается судить, если не видит контрольных', () => {
  it('пустой ответ базы — это НЕ «всех 28 нет», а «запрос слеп»', async () => {
    // Ровно прогон 1 на проде: information_schema вернул пусто, и перепись
    // объявила мёртвыми все 28 пунктов сразу — включая payments, на котором
    // стоит живой приёмник CloudPayments. Удалить код по такому ответу значило
    // бы снести рабочий платёжный путь.
    query.mockImplementation(async (sql: string) =>
      sql.includes('current_user')
        ? { rows: [{ db_user: 'app', db_name: 'prod', schema: 'other', search_path: 'other,public' }] }
        : { rows: [] },
    );

    const body = await callRoute();

    expect(body.success).toBe(false);
    expect(body.counts.unknown).toBe(UNDECLARED_TABLES.length);
    expect(body.counts.absent, 'слепой запрос не вправе объявлять таблицы мёртвыми').toBe(0);
    expect(body.verdict).toContain('НЕ ВЕРИТЬ ОТВЕТУ');
    expect(body.verdict, 'приговор обязан прямо запрещать удаление кода').toContain('удалять по нему код НЕЛЬЗЯ');
    expect(body.canary?.ok).toBe(false);
    expect(body.canary?.missing).toEqual([...CANARY_TABLES]);
    // Куда смотрели — единственное, что помогает разобрать слепоту.
    expect(body.connection?.search_path).toBe('other,public');
  });

  it('пропажа ОДНОЙ контрольной таблицы уже отменяет вердикт', async () => {
    // Порог намеренно нулевой: канарейки выбраны так, что каждая обязана быть.
    // «Три из четырёх видны, значит почти хорошо» — та же арифметика, из-за
    // которой частичная правда выдаётся за целую.
    const [absentCanary, ...rest] = CANARY_TABLES;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ db_user: 'app', schema: 'public' }] };
      return sql.includes('query_to_xml')
        ? { rows: rest.map((t) => ({ table_name: t, any_row: '1' })) }
        : { rows: [] };
    });

    const body = await callRoute();

    expect(body.success).toBe(false);
    expect(body.canary?.missing).toEqual([absentCanary]);
    expect(body.counts.unknown).toBe(UNDECLARED_TABLES.length);
  });

  it('контрольные таблицы не попадают в раскладку списка', async () => {
    // Иначе канарейка сама стала бы «пунктом реестра» и раздула бы счёт.
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ db_user: 'app', schema: 'public' }] };
      return sql.includes('query_to_xml') ? { rows: withCanary([]) } : { rows: [] };
    });

    const body = await callRoute();

    expect(body.counts.total).toBe(UNDECLARED_TABLES.length);
    expect(body.tables.some((r) => (CANARY_TABLES as readonly string[]).includes(r.table))).toBe(false);
    expect(body.canary?.ok).toBe(true);
  });

  it('объявленные под сомнением спрашиваются, но в раскладку списка не входят', async () => {
    // Их вопрос другой: замороженный список стережёт ОБЪЯВЛЕННОСТЬ, а эти
    // объявлены — под сомнением их ПРИМЕНЁННОСТЬ (CREATE TABLE с внешним
    // ключом на отсутствующую таблицу не выполняется вовсе). Разные смыслы —
    // разные секции ответа, иначе счёт пунктов реестра поедет.
    const [suspect] = SUSPECT_DECLARED_TABLES;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ db_user: 'app', schema: 'public' }] };
      return sql.includes('query_to_xml')
        ? { rows: withCanary([{ table_name: suspect, any_row: '1' }]) }
        : { rows: [] };
    });

    const body = await callRoute();

    expect(body.counts.total).toBe(UNDECLARED_TABLES.length);
    expect(body.tables.some((r) => r.table === suspect)).toBe(false);
    expect(body.suspect_declared).toEqual(
      SUSPECT_DECLARED_TABLES.map((t) => ({
        table: t,
        present: t === suspect,
        alive: t === suspect,
      })),
    );
  });

  it('при слепой переписи сомнительные тоже не судятся', async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes('current_user') ? { rows: [{ db_user: 'app' }] } : { rows: [] },
    );
    const body = await callRoute();
    // null, а не «их нет»: слепой запрос не вправе судить и о них.
    expect(body.suspect_declared).toBeNull();
  });

  it('контрольные и проверяемые спрашиваются ОДНИМ запросом', () => {
    // Разными запросами канарейка перестала бы быть канарейкой: она обязана
    // пройти тот же путь, что и проверяемое, иначе доказывает не то.
    const src = readFileSync(ROUTE_SRC, 'utf8');
    expect(src).toContain('const ASKED');
    for (const part of ['...UNDECLARED_TABLES', '...CANARY_TABLES', '...SUSPECT_DECLARED_TABLES']) {
      expect(src).toContain(part);
    }
  });
});

describe('перепись читает тот же список, что и сторож схемы', () => {
  it('роут не заводит своей копии имён', () => {
    const src = readFileSync(ROUTE_SRC, 'utf8');
    expect(src).toContain("from '@/lib/db/undeclared-registry'");
    // Две копии списка разошлись бы, и перепись начала бы молчать ровно о том,
    // что сторож считает бедой.
    for (const t of UNDECLARED_TABLES) {
      expect(src.includes(`'${t}'`), `имя ${t} вписано в роут руками — список должен быть один`).toBe(false);
    }
  });

  it('реестр не зависит от диска — иначе он мёртв в standalone-бандле', () => {
    // Комментарии снимаются: шапка реестра ОБЪЯСНЯЕТ, почему в нём нет чтения
    // диска, и потому называет запрещённые имена. Объяснение запрета — не
    // нарушение, и различать их обязан извлекатель, а не удача. Тот же приём
    // ниже и в ledger-check-recent-order: там комментарий про сломанный запрос
    // сломал сторож сломанного запроса.
    const src = readFileSync(join(process.cwd(), 'lib/db/undeclared-registry.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/from\s+'node:fs'|require\('fs'\)|readdirSync|execSync/);
  });
});

describe('перепись только читает и не строит SQL конкатенацией', () => {
  const src = readFileSync(ROUTE_SRC, 'utf8');
  // Комментарии выброшены: они обсуждают и запреты, и SQL, и сами по себе
  // сработали бы на любой сторож-по-тексту (эта яма в репозитории уже была —
  // см. ledger-check-recent-order).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('нет ни одной записывающей команды', () => {
    for (const verb of ['INSERT', 'UPDATE ', 'DELETE', 'DROP', 'CREATE', 'TRUNCATE', 'ALTER']) {
      expect(code.includes(verb), `перепись диагностическая: ${verb} в ней недопустим`).toBe(false);
    }
  });

  it('имя таблицы подставляет сервер через format(%I), а не строка в TS', () => {
    expect(code).toContain("format('SELECT count(*)");
    expect(code).toContain('%I');
    // Правило про параметризацию не имеет исключения «источник надёжный»:
    // имя из замороженного списка запрет не снимает.
    expect(code).not.toMatch(/public\.\$\{/);
    expect(code).toContain('ANY($1::text[])');
  });

  it('версия контракта объявлена — воркфлоу ждёт именно её', () => {
    expect(code).toMatch(/contract_version:\s*\d+/);
  });
});
