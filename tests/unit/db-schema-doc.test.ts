/**
 * docs/DB_SCHEMA.md — справочник схемы, снятый с настоящей базы.
 *
 * Сторож держит одно: справочник не отстаёт от миграций молча. Файл несёт
 * имя последней миграции, с которой снят; появилась миграция новее — тест
 * красный с инструкцией, как перегенерировать. Отставший справочник хуже
 * отсутствующего: по нему пишут SQL против колонки, которой уже нет
 * (или ещё нет), и узнают об этом от прода (CLAUDE.md §4.0).
 *
 * Содержимое не проверяется — оно снимается с базы, и судить его статикой
 * запрещено. Проверяется только свежесть и то, что ядро §4.1 на месте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DOC = join(ROOT, 'docs', 'DB_SCHEMA.md');
const MIGRATIONS = join(ROOT, 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Меняет ли миграция СХЕМУ. Справочник снят со схемы, и миграция, которая
 * только пишет строки, устареть его не может: колонок от INSERT не
 * прибавляется и не убывает.
 *
 * Уточнение внесено 11.09.2026, когда сторож потребовал перегенерации из-за
 * миграции 952 — а та вставляет партнёра и два тура и не содержит ни одной
 * DDL-инструкции. Перегенерация требует живой базы; требовать её ради
 * INSERT'а значит либо блокировать работу, либо (хуже) научить правку шапки
 * рукой. Отредактированная рукой шапка — ровно то враньё, от которого сторож
 * и поставлен: она утверждала бы снимок, которого не делали.
 *
 * Предикат намеренно ГРУБЫЙ и закрывается в сторону «схема»: любое из слов
 * ниже в любом месте файла — включая тело `DO $$ ... EXECUTE`, где DDL
 * собирается строкой, — считается изменением схемы. Ошибиться здесь можно
 * только в одну сторону: лишняя перегенерация стоит времени, пропущенная —
 * справочника, по которому пишут SQL против несуществующей колонки.
 */
const DDL = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b|\bCOMMENT\s+ON\b/i;

function changesSchema(file: string): boolean {
  let body: string;
  try {
    body = readFileSync(join(MIGRATIONS, file), 'utf-8');
  } catch {
    // Файл не прочитался — мы НЕ ЗНАЕМ, что в нём. «Не знаю» здесь означает
    // «считаем схемным»: молчаливое «данные» пропустило бы правку схемы.
    return true;
  }
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
  return DDL.test(code);
}

/** Последняя миграция, менявшая схему. По ней и судится свежесть справочника. */
function lastSchemaMigration(): string {
  const files = migrationFiles().filter(changesSchema);
  return files[files.length - 1] ?? '';
}

describe('docs/DB_SCHEMA.md — справочник схемы БД', () => {
  it('существует и порождён генератором, а не написан руками', () => {
    expect(existsSync(DOC)).toBe(true);
    const body = readFileSync(DOC, 'utf-8');
    expect(body).toContain('scripts/gen-db-schema.ts');
    expect(body).toMatch(/Снято \d{4}-\d{2}-\d{2} с настоящего PostgreSQL/);
  });

  it('не отстаёт ни от одной миграции, менявшей схему', () => {
    const body = readFileSync(DOC, 'utf-8');
    const m = body.match(/Последняя миграция в снимке: `([^`]+)`/);
    expect(m, 'в шапке нет имени последней миграции').not.toBeNull();

    const snapshot = m?.[1] ?? '';
    const files = migrationFiles();
    const lastSchema = lastSchemaMigration();

    expect(files, `в шапке справочника миграция ${snapshot}, а в migrations/ такого файла нет`)
      .toContain(snapshot);

    // Сравниваем ПОЛОЖЕНИЕМ в общем отсортированном списке, а не равенством:
    // снимок, сделанный ПОЗЖЕ последней схемной миграции (например на
    // data-only 952), справочник не портит — он просто свежее необходимого.
    expect(
      files.indexOf(snapshot) >= files.indexOf(lastSchema),
      `docs/DB_SCHEMA.md снят с ${snapshot}, а схему меняла более поздняя ${lastSchema}. ` +
        'Перегенерировать: см. шапку scripts/gen-db-schema.ts (baseline + migrate + npm run db:schema-doc).',
    ).toBe(true);
  });

  it('data-only миграция перегенерации не требует, схемная — требует', () => {
    // Сторож обязан уметь различать эти два случая, иначе уточнение выше —
    // просто ослабленная проверка. Судим на выдуманных телах, не трогая диск.
    const ddlLike = 'ALTER TABLE partners ADD COLUMN x text;';
    const dataOnly = "INSERT INTO partners (name) SELECT 'Яна' WHERE NOT EXISTS (SELECT 1);";
    const commentedDdl = '-- когда-то здесь был CREATE TABLE\nINSERT INTO t VALUES (1);';
    expect(DDL.test(ddlLike), 'ALTER не опознан как изменение схемы').toBe(true);
    expect(DDL.test(dataOnly), 'чистый INSERT принят за изменение схемы').toBe(false);
    expect(
      DDL.test(commentedDdl.replace(/^\s*--.*$/gm, ' ')),
      'DDL-слово в комментарии засчитано за изменение схемы',
    ).toBe(false);
  });

  it('ядро §4.1 присутствует: три master-таблицы и их связка', () => {
    const body = readFileSync(DOC, 'utf-8');
    for (const t of ['places', 'kamchatka_routes', 'operator_tours', 'route_waypoints', 'operator_bookings', 'sos_events', 'external_alerts']) {
      expect(body, `в справочнике нет таблицы ${t}`).toContain(`**${t}**`);
    }
    // Связи, которых в базе нет (держит код), обязаны быть нарисованы пунктиром —
    // читатель должен видеть, что FK их не охраняет.
    expect(body).toContain('places ||..o{ location_safety_profile');
    expect(body).toContain('places ||..o{ ai_route_images');
  });

  it('генератор доступен одной командой', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:schema-doc']).toContain('scripts/gen-db-schema.ts');
  });
});
