/**
 * Перепись формы «вставь, если такого ещё нет»: копия не расходится с оригиналом.
 *
 * Проверка PREPARE-ом полезна ровно настолько, насколько её реестр
 * соответствует коду. Копия, отставшая от оригинала, проверяет запрос,
 * которого больше нет, и отвечает зелёным про живой — это хуже отсутствия
 * проверки, потому что выглядит как проверка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPES } from '@/app/api/cron/sql-shape-check/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/sql-shape-check/route.ts'), 'utf-8');

/** Скелет: сравниваем смысл, а не отступы. */
function skeleton(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('реестр форм сверен с исходниками', () => {
  it('реестр не пуст: ноль записей — отказ переписи, а не «нарушений нет»', () => {
    expect(SHAPES.length).toBeGreaterThan(0);
  });

  for (const shape of SHAPES) {
    it(`«${shape.name}» дословно присутствует в ${shape.source}`, () => {
      const file = skeleton(readFileSync(join(process.cwd(), shape.source), 'utf-8'));
      expect(file).toContain(skeleton(shape.sql));
    });
  }

  it('имена файлов уникальны настолько, насколько уникальны запросы', () => {
    const sqls = SHAPES.map((s) => skeleton(s.sql));
    expect(new Set(sqls).size).toBe(sqls.length);
  });
});

describe('перепись ничего не выполняет', () => {
  it('проверка идёт PREPARE-ом, а не запуском', () => {
    expect(SRC).toMatch(/PREPARE \$\{stmt\} AS/);
  });

  it('соединение возвращается в пул чистым', () => {
    expect(SRC).toMatch(/finally \{[\s\S]*DEALLOCATE ALL/);
  });

  it('отказ очистки пишется в лог, а не глотается', () => {
    expect(SRC).toMatch(/DEALLOCATE ALL'\)\.catch\(\(err\) => \{[\s\S]*console\.error/);
  });

  it('EXECUTE не встречается вовсе', () => {
    expect(SRC).not.toContain('EXECUTE ');
  });
});

describe('перепись называет границы своего знания', () => {
  it('полнота реестра держится правилом, а слепота названа', () => {
    // Прежде здесь стояло registry_is_not_exhaustive — честное, но безграничное
    // «не знаю». Теперь полноту сторожит CI (sql-param-cast-shape), и остаток
    // незнания сузился до одного названного случая.
    expect(SRC).toContain('registry_completeness_guarded_by');
    expect(SRC).toContain('tests/unit/sql-param-cast-shape.test.ts');
    expect(SRC).toContain('registry_blind_to');
  });

  it('отказ соединения — не «все запросы целы»', () => {
    expect(SRC).toMatch(/broken: null[\s\S]*отказ проверки/);
  });

  it('сказано, что проверка доказывает и чего не доказывает', () => {
    expect(SRC).toContain('proves');
    expect(SRC).toContain('does_not_prove');
  });
});

describe('маяк воронки: параметр приведён у КАЖДОГО употребления', () => {
  const RECEIVER = readFileSync(join(process.cwd(), 'app/api/funnel/route.ts'), 'utf-8');

  it('в списке SELECT и в сравнении с колонкой тип задан явно', () => {
    // Без этого PostgreSQL выводит для $1 два разных типа и отвечает 42P08 —
    // запрос не выполняется НИ РАЗУ, а пустой catch делал отказ невидимым.
    expect(RECEIVER).toMatch(/SELECT \$1::varchar, \$2::text, \$3::varchar/);
    expect(RECEIVER).toMatch(/WHERE step = \$1::varchar/);
    expect(RECEIVER).toMatch(/entity_id IS NOT DISTINCT FROM \$2::text/);
    expect(RECEIVER).toMatch(/visitor_hash = \$3::varchar/);
  });

  it('голых $1/$2/$3 в этом запросе не осталось', () => {
    const insert = RECEIVER.match(/INSERT INTO funnel_events[\s\S]*?\)`/);
    expect(insert).not.toBeNull();
    expect((insert as RegExpMatchArray)[0]).not.toMatch(/\$[123](?!::)/);
  });
});
