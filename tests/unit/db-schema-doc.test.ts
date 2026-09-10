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

function lastMigration(): string {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  return files[files.length - 1] ?? '';
}

describe('docs/DB_SCHEMA.md — справочник схемы БД', () => {
  it('существует и порождён генератором, а не написан руками', () => {
    expect(existsSync(DOC)).toBe(true);
    const body = readFileSync(DOC, 'utf-8');
    expect(body).toContain('scripts/gen-db-schema.ts');
    expect(body).toMatch(/Снято \d{4}-\d{2}-\d{2} с настоящего PostgreSQL/);
  });

  it('снят с последней миграции репозитория — иначе перегенерировать', () => {
    const body = readFileSync(DOC, 'utf-8');
    const m = body.match(/Последняя миграция в снимке: `([^`]+)`/);
    expect(m, 'в шапке нет имени последней миграции').not.toBeNull();
    const last = lastMigration();
    expect(
      m?.[1],
      `docs/DB_SCHEMA.md снят с ${m?.[1]}, а в migrations/ уже ${last}. ` +
        'Перегенерировать: см. шапку scripts/gen-db-schema.ts (baseline + migrate + npm run db:schema-doc).',
    ).toBe(last);
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
