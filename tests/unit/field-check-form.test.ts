/**
 * Полевая проверка — форма и приём (владелец 21.08).
 *
 * Три черты, ради которых это делалось, и которые нельзя потерять:
 *  1. Проверка НЕ меняет данные — только очередь со статусом pending.
 *  2. Третье состояние: координата и точность необязательны, «не с места» —
 *     законное состояние; половина координаты не принимается.
 *  3. Офлайн не теряет улику: неотправленное лежит на диске и уходит само.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const report = readFileSync(join(process.cwd(), 'app/api/field-check/report/route.ts'), 'utf-8');
const nearby = readFileSync(join(process.cwd(), 'app/api/field-check/nearby/route.ts'), 'utf-8');
const client = readFileSync(join(process.cwd(), 'app/field-check/_FieldCheckClient.tsx'), 'utf-8');
const migration = readFileSync(join(process.cwd(), 'migrations/898_route_field_checks.sql'), 'utf-8');

describe('приём проверки — очередь, а не правка', () => {
  it('пишет только в route_field_checks', () => {
    expect(report).toContain('INSERT INTO route_field_checks');
    expect(report).not.toMatch(/UPDATE kamchatka_routes|UPDATE places/);
  });

  it('статус по умолчанию — pending, решает человек', () => {
    expect(migration).toMatch(/status[\s\S]{0,80}DEFAULT 'pending'/);
  });

  it('вход валидируется Zod и параметризован', () => {
    expect(report).toContain('BodySchema.parse');
    expect(report).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/);
  });

  it('половина координаты не принимается', () => {
    expect(report).toMatch(/hasLat !== hasLng/);
  });

  it('координата и точность допускают отсутствие', () => {
    expect(report).toMatch(/reported_lat: z\.number\(\)[\s\S]{0,60}\.nullable\(\)/);
    expect(report).toMatch(/accuracy_m: z\.number\(\)[\s\S]{0,80}\.nullable\(\)/);
    expect(migration).toMatch(/accuracy_m\s+INTEGER CHECK \(accuracy_m IS NULL/);
  });
});

describe('выборка рядом — только живые записи', () => {
  it('скрытые и слитые не показываются', () => {
    expect(nearby).toMatch(/p\.is_visible = true AND p\.merged_into_id IS NULL/);
    expect(nearby).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
  });

  it('незнание показывается словами, а не нулём', () => {
    expect(client).toContain("f.value ?? 'не знаем'");
  });
});

describe('офлайн не теряет улику', () => {
  it('очередь на диске и отправка при возврате связи', () => {
    expect(client).toContain('field_check_queue_v1');
    expect(client).toMatch(/addEventListener\('online'/);
  });

  it('неотправленное видно человеку', () => {
    expect(client).toMatch(/Не отправлено: \{queueLen\}/);
  });
});
