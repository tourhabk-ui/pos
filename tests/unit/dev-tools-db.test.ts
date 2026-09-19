/**
 * Сторож: «переменная не задана» не выдаётся за «база отказала».
 *
 * ── Находка и что она недосказала (#1428) ──────────────────────────────────
 *
 * Судья: «отсутствует проверка process.env.DATABASE_URL на undefined перед
 * созданием Pool, что может привести к невнятной ошибке».
 *
 * Замер показал, что хуже. Конструктор `pg` на `undefined` НЕ БРОСАЕТ вовсе —
 * он подставляет умолчания libpq и идёт на локальную базу:
 *
 *   connect ECONNREFUSED 127.0.0.1:5432
 *
 * Вызывающий получает сообщение о том, что ЛОКАЛЬНАЯ база отказала, и ни
 * слова про незаданную переменную. Это не «невнятно» — это неверно названная
 * причина: «мы не знаем, куда подключаться» выдаётся за «база отказала».
 *
 * И это ещё удачный исход. Там, где локальный Postgres поднят и в нём есть
 * база с именем пользователя, подключение УДАЁТСЯ — к чужой базе, и
 * инструмент ответит неверными данными молча.
 *
 * ── Что держится ───────────────────────────────────────────────────────────
 *
 * Отказ называет ПЕРЕМЕННУЮ, пул создаётся ЛЕНИВО (иначе три инструмента без
 * базы умерли бы из-за переменной, которая им не нужна), и в самом сервере не
 * осталось жадного `new Pool`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devToolsDb, resetDevToolsDb } from '@/lib/mcp/dev-tools/db';

const ROOT = process.cwd();
const SERVER = readFileSync(join(ROOT, 'lib/mcp/dev-tools/server.ts'), 'utf-8');

describe('отказ называет причину, а не подменяет её', () => {
  const prev = process.env.DATABASE_URL;
  beforeEach(() => resetDevToolsDb());
  afterEach(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
    resetDevToolsDb();
  });

  it('переменной нет — в тексте названа она, а не localhost', () => {
    delete process.env.DATABASE_URL;
    expect(() => devToolsDb()).toThrow(/DATABASE_URL/);
    // Прежнее поведение: ECONNREFUSED 127.0.0.1:5432. Если оно вернётся,
    // причина снова будет названа неверно.
    try { devToolsDb(); } catch (e) {
      expect((e as Error).message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    }
  });

  it('пустая строка и пробелы — то же самое, что отсутствие', () => {
    // `connectionString: ''` ведёт себя как undefined: те же умолчания libpq.
    for (const bad of ['', '   ', '\t\n']) {
      process.env.DATABASE_URL = bad;
      resetDevToolsDb();
      expect(() => devToolsDb(), JSON.stringify(bad)).toThrow(/DATABASE_URL/);
    }
  });

  it('отказ говорит, какие инструменты всё-таки работают', () => {
    // Иначе человек решит, что сломан весь сервер, и пойдёт чинить не то.
    delete process.env.DATABASE_URL;
    try { devToolsDb(); } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('next_migration_id');
      expect(m).toContain('.env.local');
    }
  });

  it('переменная есть — пул создаётся и переиспользуется', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    const a = devToolsDb();
    const b = devToolsDb();
    expect(a).toBe(b);   // ленивый singleton, а не новый пул на каждый вызов
  });
});

describe('в сервере не осталось жадного пула', () => {
  it('своего new Pool нет', () => {
    expect(SERVER, 'жадный Pool вернулся — три инструмента без базы снова умрут вместе с ним')
      .not.toMatch(/new Pool\(/);
  });

  it('все запросы идут через общий резолвер', () => {
    expect(SERVER).not.toMatch(/\bdbPool\b/);
    expect((SERVER.match(/devToolsDb\(\)\.query\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it('.mcp.json рабочего каталога не задаёт — и в шапке сказано именно это', () => {
    /**
     * Прежние комментарии ссылались на `.mcp.json` как на то, что задаёт
     * рабочий каталог, — при том что файла не было вовсе. Обещание пути,
     * которого нет, — дефект кода (правило 10.09).
     *
     * 19.09 файл появился (решение владельца), и тест сработал ровно так, как
     * сам себе обещал: «появится настоящий `.mcp.json` — тест потребует
     * переписать комментарий, и это будет правдой». Комментарий переписан, а
     * проверка перешла с ФАКТА СУЩЕСТВОВАНИЯ на ФАКТ, который и был важен:
     * этот файл наш сервер не запускает и cwd ему не задаёт.
     *
     * Так и должно быть: сторож держал не отсутствие файла ради отсутствия, а
     * соответствие шапки действительности. Оставить прежнюю форму значило бы
     * запретить конфиг ПОТРЕБЛЯЕМЫХ серверов из-за строки про ЗАПУСК своего.
     */
    const path = join(ROOT, '.mcp.json');
    if (existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path, 'utf-8')) as {
        mcpServers?: Record<string, { command?: unknown; cwd?: unknown }>;
      };
      for (const [name, entry] of Object.entries(cfg.mcpServers ?? {})) {
        expect(
          entry.command ?? null,
          `сервер ${name} в .mcp.json запускается командой — значит файл снова задаёт запуск и cwd, `
          + 'и шапка lib/mcp/dev-tools/server.ts должна быть переписана заново',
        ).toBeNull();
        expect(entry.cwd ?? null, `сервер ${name} в .mcp.json задаёт cwd`).toBeNull();
      }
    }
    expect(
      SERVER,
      'в шапке должно быть сказано, что cwd задаёт запускающий, а не .mcp.json',
    ).toMatch(/запускающий обязан задать cwd сам/i);
  });
});
