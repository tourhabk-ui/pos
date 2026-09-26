/**
 * Каждая роль, которую код ПИШЕТ в users.role, разрешена CHECK-ом
 * `users_role_check` (миграция 1026).
 *
 * До 26.09 CHECK из baseline знал шесть ролей, а регистрация, переключение
 * роли и админские пути писали ещё 'stay' и 'gear' — каждая такая запись
 * отвечала 23514, и владелец жилья не мог зарегистрироваться вовсе. Юнит-
 * тесты с моками базы этого не видели: CHECK живёт в базе, а не в коде.
 *
 * Сторож держит связку целиком: список ролей берётся из самих писателей
 * (их Zod-перечней и справочников), а CHECK — из ПОСЛЕДНЕГО по порядку
 * применения определения в baseline + migrations/. Новый писатель с новой
 * ролью краснеет здесь, пока миграция её не разрешит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';
import { SWITCHABLE_ROLES } from '@/lib/auth/role-switch';

const read = (p: string) => readFileSync(p, 'utf-8');

/** Литералы ролей из `const NAME = [ ... ] as const` или `z.enum([ ... ])`. */
function literalsIn(src: string, anchor: RegExp): string[] {
  const m = anchor.exec(src);
  if (!m) throw new Error(`не найден список ролей по ${anchor}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

function allowedByLatestCheck(): Set<string> {
  const files = readdirSync('migrations')
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map(f => `migrations/${f}`);
  let latest: string | null = null;
  for (const f of ['lib/database/baseline/schema-baseline.sql', ...files]) {
    const src = read(f);
    const idx = src.lastIndexOf('users_role_check CHECK');
    if (idx >= 0) latest = src.slice(idx, idx + 600);
  }
  if (!latest) throw new Error('users_role_check не найден ни в baseline, ни в миграциях');
  const body = latest.slice(0, latest.indexOf(';'));
  return new Set([...body.matchAll(/'([a-z_]+)'/g)].map(x => x[1]));
}

const WRITERS: Record<string, string[]> = {
  'app/api/auth/register (VALID_ROLES)':
    literalsIn(read('app/api/auth/register/route.ts'), /const VALID_ROLES = \[([^\]]+)\]/),
  'app/api/partners/register (roles enum)':
    literalsIn(read('app/api/partners/register/route.ts'), /roles: z\.array\(z\.enum\(\[([^\]]+)\]/),
  'app/api/roles (validRoles)':
    literalsIn(read('app/api/roles/route.ts'), /const validRoles = \[([^\]]+)\]/),
  'lib/auth/role-routes PARTNER_ROLES (register-operator, admin/operators/create)': [...PARTNER_ROLES],
  'lib/auth/role-switch SWITCHABLE_ROLES (switch-role)': [...SWITCHABLE_ROLES],
};

describe('users_role_check покрывает роли, которые пишет код', () => {
  const allowed = allowedByLatestCheck();

  for (const [writer, roles] of Object.entries(WRITERS)) {
    it(writer, () => {
      expect(roles.length).toBeGreaterThan(0);
      const missing = roles.filter(r => !allowed.has(r));
      expect(missing, `роли вне CHECK: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('владелец жилья и прокат — разрешены (случай 26.09)', () => {
    expect(allowed.has('stay')).toBe(true);
    expect(allowed.has('gear')).toBe(true);
  });

  it('CHECK не разрешает того, чего никто не пишет', () => {
    const written = new Set(Object.values(WRITERS).flat());
    // Литеральные писатели вне перечней: telegram/max → 'tourist',
    // create-agent → 'agent', import-mestechko → 'operator'.
    for (const r of ['tourist', 'agent', 'operator']) written.add(r);
    const unproduced = [...allowed].filter(r => !written.has(r));
    expect(unproduced, `в CHECK без производителя: ${unproduced.join(', ')}`).toEqual([]);
  });
});
