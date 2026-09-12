/**
 * /api/admin/places/[id]/description-draft — единственное место, откуда
 * текст из ГВП может попасть в `places.description` (#1830).
 *
 * Держит связку: только этот роут пишет `places.description` из всей
 * фичи черновиков, только через requireAdmin, только для 'pending', и
 * только явным action approve/reject — не молчаливым дефолтом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/admin/places/[id]/description-draft/route.ts'), 'utf-8');

describe('description-draft — ревью и публикация', () => {
  it('экспортирует GET и PATCH, не более', () => {
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).toMatch(/export async function PATCH/);
    expect(SRC).not.toMatch(/export async function (POST|PUT|DELETE)/);
  });

  it('требует requireAdmin', () => {
    expect(SRC).toContain('requireAdmin');
  });

  it('публикация возможна только из статуса pending', () => {
    expect(SRC).toMatch(/status\s*!==\s*'pending'/);
  });

  it('action — enum approve/reject через Zod, не свободная строка', () => {
    expect(SRC).toMatch(/z\.enum\(\['approve',\s*'reject'\]\)/);
  });

  it('только approve пишет places.description', () => {
    const updatePlacesIdx = SRC.search(/UPDATE\s+places\s+SET/i);
    expect(updatePlacesIdx, 'нет ни одного UPDATE places.description').toBeGreaterThan(0);
    const before = SRC.slice(0, updatePlacesIdx);
    // Последнее упоминание action === 'approve' перед самим UPDATE.
    expect(before).toMatch(/action === 'approve'/);
  });
});
