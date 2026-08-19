/**
 * Пилот на двоих (владелец 15.08): «Камчатская рыбалка» + «Камчатка
 * Семейный Рафтинг». Аудит проб 106-107: виджет лидов выключен у обоих,
 * рафтинг непубличен. Миграция 863 включает точечно.
 *
 * Сторож держит форму миграции: только точечные UPDATE по конкретным id —
 * массовое включение виджетов или публичности всем партнёрам недопустимо.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = readFileSync(join(process.cwd(), 'migrations/863_pilot_partners.sql'), 'utf-8');

describe('миграция 863: пилотные партнёры', () => {
  it('оба партнёра включены по конкретным id', () => {
    expect(MIG).toMatch(/0aaa4f05-b479-418b-9d54-2b909783dfd7/);
    expect(MIG).toMatch(/ead39acc-85c8-41c9-8f75-3a7092f7f699/);
    expect(MIG).toMatch(/widget_enabled = true/);
    expect(MIG).toMatch(/is_public = true/);
  });

  it('каждый UPDATE гейтится WHERE id — массовых включений нет', () => {
    const updates = MIG.match(/UPDATE partners/g) ?? [];
    const gated = MIG.match(/WHERE id = '/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(gated.length).toBe(updates.length);
  });

  it('slug рафтинга не перетирает существующий (COALESCE)', () => {
    expect(MIG).toMatch(/slug = COALESCE\(slug, 'kamchatka-semeyny-rafting'\)/);
  });
});
