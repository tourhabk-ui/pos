/**
 * tests/unit/cron-capability-frozen.test.ts
 *
 * Что крон УМЕЕТ — объявлено, и новая возможность не появляется тихо.
 *
 * ── Откуда правило (дайджест 08.09) ────────────────────────────────────────
 *
 * Разбор скиллов ИИ-агентов: вопрос «безопасен ли скилл» неотвечаем — судить
 * придётся о намерении. Вопрос «что он умеет» отвечаем полностью и проверяется
 * машиной. У нас этот приём уже работает по частям: `provider-registry` морозит
 * LLM-хосты, `cron-schedulers` требует объявить, кто запускает роут,
 * `schema-coverage` морозит неучтённые таблицы. Не было общего ответа на «что
 * этот крон может сделать».
 *
 * ── Что ловится ────────────────────────────────────────────────────────────
 *
 * Появление возможности, а не её наличие. Роут-перепись, объявленная read-only,
 * получает строку `UPDATE`; роут диагностики обзаводится вызовом модели и
 * начинает жечь токены по расписанию. В диффе оба выглядят обычной правкой в
 * файле, который «и так про это».
 *
 * ── Чего сторож НЕ утверждает ──────────────────────────────────────────────
 *
 * Что роут чего-то не умеет. Перечень собран статикой, у неё есть предел:
 * динамический `await import()` и всё за глубиной обхода в него не попадают.
 * Судить по нему можно ровно об ИЗМЕНЕНИИ перечня — и урок 24.08 (сторож
 * приведения типов пометил два рабочих запроса, потому что судил статикой
 * рантайм) здесь учтён именно так.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanCapabilities,
  diffCapabilities,
  stripComments,
  capabilitiesInSource,
  ownImports,
  ALL_CAPABILITIES,
  DEFAULT_DEPTH,
  type Capability,
} from '@/lib/agents/cron-capabilities';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const ROOT = process.cwd();

/**
 * Прочитать или честно вернуть null — одним действием, без пары
 * «проверил существование, потом прочитал»: между ними окно, в котором файл
 * может измениться, и это настоящая гонка, а не придирка сканера.
 */
function tryRead(relPath: string): string | null {
  try {
    return readFileSync(join(ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function read(id: string): string | null {
  for (const c of [`${id}.ts`, `${id}.tsx`, join(id, 'index.ts')]) {
    const src = tryRead(c);
    if (src !== null) return src;
  }
  return null;
}

function cronKeys(): string[] {
  return readdirSync(join(ROOT, 'app', 'api', 'cron'), { withFileTypes: true })
    .filter(e => e.isDirectory() && tryRead(`app/api/cron/${e.name}/route.ts`) !== null)
    .map(e => e.name)
    .sort();
}

describe('перечень возможностей заморожен', () => {
  it('каждый крон-роут объявлен', () => {
    const missing = cronKeys().filter(k => !(k in CRON_CAPABILITIES));
    expect(
      missing,
      `не объявлены: ${missing.join(', ')}. Обнови реестр тем же коммитом: `
      + 'npx tsx scripts/cron-capability-census.ts --freeze',
    ).toEqual([]);
  });

  it('в реестре нет призраков — роутов, которых больше нет', () => {
    const keys = new Set(cronKeys());
    const ghosts = Object.keys(CRON_CAPABILITIES).filter(k => !keys.has(k));
    expect(ghosts, `в реестре есть, в коде нет: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('ни один роут не получил возможность молча', () => {
    const gained: string[] = [];
    for (const key of cronKeys()) {
      const declared = CRON_CAPABILITIES[key] ?? [];
      const actual = scanCapabilities(`app/api/cron/${key}/route`, read).capabilities;
      const d = diffCapabilities(declared, actual);
      if (d.gained.length > 0) gained.push(`${key}: +${d.gained.join(',')}`);
    }
    expect(
      gained,
      'Появилась возможность, которой в объявлении нет. Это не обязательно ошибка — '
      + 'но она обязана быть ВИДНОЙ: внеси её тем же коммитом и напиши в сообщении, зачем. '
      + `Список: ${gained.join('; ')}`,
    ).toEqual([]);
  });

  it('исчезнувшая возможность — повод почистить реестр, и он называется', () => {
    // Отдельно от появления и мягче: потеря возможности не опасна, но
    // протухший реестр перестаёт быть эталоном.
    const lost: string[] = [];
    for (const key of cronKeys()) {
      const declared = CRON_CAPABILITIES[key] ?? [];
      const actual = scanCapabilities(`app/api/cron/${key}/route`, read).capabilities;
      const d = diffCapabilities(declared, actual);
      if (d.lost.length > 0) lost.push(`${key}: -${d.lost.join(',')}`);
    }
    expect(lost, `объявлено больше, чем есть: ${lost.join('; ')}`).toEqual([]);
  });
});

describe('перечень различает, а не срабатывает у всех', () => {
  it('«умеет всё» — не перечень: ни одна возможность не истинна у всех роутов', () => {
    // Смысл сторожа: признак, верный у 97% роутов, создаёт вид проверки и не
    // сообщает ничего. Именно на этом был снят транзитивный ПД (30→66→156→173).
    const keys = cronKeys();
    for (const cap of ALL_CAPABILITIES) {
      const n = keys.filter(k => (CRON_CAPABILITIES[k] ?? []).includes(cap)).length;
      expect(n, `возможность ${cap} объявлена у ВСЕХ ${keys.length} роутов — она ничего не различает`)
        .toBeLessThan(keys.length);
    }
  });

  it('деньги — редкая возможность, и это проверяемо', () => {
    // Если однажды окажется, что платежей касается половина кронов, это не
    // «реестр разросся», а находка.
    const n = cronKeys().filter(k => (CRON_CAPABILITIES[k] ?? []).includes('money' as Capability)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(20);
  });
});

describe('чтение исходника: считаем код, а не рассказ о нём', () => {
  it('SQL из комментария возможностью не считается', () => {
    // В этом репозитории комментарии длинные и цитируют код дословно. Без
    // вычистки перечень описывал бы комментарии.
    const src = `// раньше здесь стоял INSERT INTO leads\nexport const x = 1;`;
    expect(capabilitiesInSource(src)).not.toContain('db_write');
  });

  it('блочный комментарий тоже не считается', () => {
    const src = `/** Шлём через api.telegram.org */\nexport const x = 1;`;
    expect(capabilitiesInSource(src)).not.toContain('telegram');
  });

  it('адрес со схемой не принимается за комментарий', () => {
    // `https://` содержит `//`, и наивная резка убила бы половину строки —
    // вместе с настоящим вызовом.
    const kept = stripComments(`const u = 'https://api.telegram.org/bot'; tgSend(u);`);
    expect(kept).toContain('api.telegram.org');
    expect(kept).toContain('tgSend');
  });

  it('живой код считается', () => {
    const caps = capabilitiesInSource(`await pool.query('INSERT INTO t (a) VALUES ($1)', [1]);`);
    expect(caps).toContain('db_write');
    expect(caps).toContain('db_read');
  });
});

describe('обход графа знает свои границы', () => {
  it('свои импорты видны, чужие пакеты — нет', () => {
    const imports = ownImports(`import { pool } from '@/lib/db-pool';\nimport React from 'react';`);
    expect(imports).toEqual(['lib/db-pool']);
  });

  it('динамический импорт своего модуля тоже виден', () => {
    expect(ownImports(`const m = await import('@/lib/agents/watchdog');`)).toEqual(['lib/agents/watchdog']);
  });

  it('непрочитанный модуль уходит в unexplored, а не в «ничего не умеет»', () => {
    // Ключевая граница: отсутствие ответа не равно ответу «нет» (§4.0).
    const scan = scanCapabilities('lib/нет-такого', () => null);
    expect(scan.capabilities).toEqual([]);
    expect(scan.unexplored).toContain('lib/нет-такого');
  });

  it('за пределом глубины модуль объявлен недосмотренным', () => {
    const files: Record<string, string> = {
      a: `import { x } from '@/b';`,
      b: `import { y } from '@/c';`,
      c: `await pool.query('INSERT INTO t VALUES (1)');`,
    };
    const shallow = scanCapabilities('a', (id) => files[id] ?? null, 1);
    expect(shallow.capabilities).not.toContain('db_write');
    expect(shallow.unexplored).toContain('c');

    const deep = scanCapabilities('a', (id) => files[id] ?? null, 2);
    expect(deep.capabilities).toContain('db_write');
    expect(deep.unexplored).toEqual([]);
  });

  it('глубина по умолчанию — та, на которой признаки выходят на полку', () => {
    expect(DEFAULT_DEPTH).toBe(2);
  });
});
