/**
 * Журнал аудита (/api/admin/audit-log) — регрессия
 * «UNION types uuid and text cannot be matched».
 * Была мёртвая, но выполняемая count-подзапрос-обёртка, где первая ветка
 * UNION отдавала audit_logs.id (uuid), а прочие — id::text. Она падала до
 * основного CTE (там total уже считается корректно). Удалена.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/api/admin/audit-log/route.ts', 'utf8');

describe('audit-log UNION', () => {
  it('нет сырого «SELECT id FROM audit_logs» в UNION (uuid vs text)', () => {
    expect(src).not.toMatch(/SELECT id FROM audit_logs/);
  });

  it('total берётся из CTE-запроса (countQ), не из мёртвой обёртки', () => {
    expect(src).toMatch(/countQ/);
    expect(src).not.toMatch(/countResult/);
  });

  it('все id в CTE приведены к ::text', () => {
    expect(src).toMatch(/al\.id::text/);
    expect(src).toMatch(/alog\.id::text/);
    expect(src).toMatch(/bl\.id::text/);
  });
});
