/**
 * /api/cron/pwa-installs-census — только чтение, тот же счёт, что у
 * requireAdmin /api/admin/dashboard, но без входа в аккаунт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/pwa-installs-census/route.ts'), 'utf-8');

describe('pwa-installs-census — только чтение', () => {
  it('экспортирует только GET', () => {
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('нет ни одного write-запроса', () => {
    expect(SRC).not.toMatch(/UPDATE|INSERT INTO|DELETE FROM/);
  });

  it('авторизация — Bearer CRON_SECRET, постоянным временем', () => {
    expect(SRC).toContain('getCronSecret');
    expect(SRC).toContain('timingSafeCompare');
  });

  it('считает устройства (client_id — PK, дедуп на запись), не сырые события', () => {
    expect(SRC).toMatch(/COUNT\(\*\)::text AS total FROM pwa_installs/);
  });

  it('маркер версии для probe есть', () => {
    expect(SRC).toMatch(/pwa_installs_census_v\d+/);
  });
});
