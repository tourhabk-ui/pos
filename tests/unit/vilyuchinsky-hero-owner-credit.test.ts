/**
 * Главный кадр вулкана Вилючинский подписан владельцем (15.10, миграция 1259).
 *
 * Кадр загружен через админку 30.06, когда полей автора в форме ещё не было;
 * владелец, увидев его, ответил «Мой — подписать». Сторож держит, что подпись
 * ложится ровно на эту загрузку — по месту, способу загрузки, пустому автору и
 * моменту загрузки, — и не перепишет ни чужой автор, ни снимок, поставленный
 * позже.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationBody, migrationStatements } from '../helpers/migration-sql';

const BODY = migrationBody(readFileSync(join(process.cwd(), 'migrations/1259_vilyuchinsky_hero_owner_credit.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);
const s = STATEMENTS.find((x) => /UPDATE ai_route_images/.test(x))!;

describe('подпись главного кадра вулкана Вилючинский', () => {
  it('подписывает владельцем — без лицензии: снимок собственный', () => {
    expect(s).toMatch(/SET author = 'владелец платформы'\s*\n/);
    expect(BODY).not.toMatch(/license\s*=/);
  });

  it('только эту загрузку: место, ручная загрузка, пустой автор, момент 30.06', () => {
    expect(s).toContain("p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'");
    expect(s).toMatch(/AND i\.route_id = p\.ark_id/);
    expect(s).toMatch(/AND i\.model = 'manual-upload'/);
    expect(s).toMatch(/AND i\.author IS NULL/);
    const epoch = Number(/EXTRACT\(EPOCH FROM i\.created_at\)::bigint = (\d+)/.exec(s)![1]);
    expect(new Date(epoch * 1000).toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('больше ничего не трогается', () => {
    expect(STATEMENTS.filter((x) => /\bUPDATE\b|\bINSERT\b|\bDELETE\b/.test(x))).toHaveLength(1);
  });
});
