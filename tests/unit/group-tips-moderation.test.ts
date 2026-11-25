/**
 * Советы туристов из Telegram-групп не становятся данными платформы без
 * модерации (скан безопасности 25.11).
 *
 * Бот слушает любую группу, куда его добавили, а поиск Кузьмича берёт из
 * kamchatka_routes всё видимое. Прежде монитор писал совет сразу видимым —
 * и чужая группа могла выдать туристу «на Авачинский безопасно без гида»
 * как проверенный факт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/telegram/group-monitor.ts'), 'utf-8');
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const MIGRATION = readFileSync(join(ROOT, 'migrations/1513_group_tips_hidden_until_moderation.sql'), 'utf-8');

describe('совет из группы пишется скрытым', () => {
  const insert = /INSERT INTO kamchatka_routes[\s\S]*?`/.exec(CODE)?.[0] ?? '';

  it('INSERT найден', () => expect(insert).not.toBe(''));

  it('новая строка — is_visible = false', () => {
    expect(insert).toMatch(/\$8::jsonb,\s*false,\s*NOW\(\)/);
    expect(insert).not.toMatch(/\$8::jsonb,\s*true/);
  });

  it('новый текст под тем же ключом снова скрывает строку', () => {
    expect(insert).toMatch(/ON CONFLICT[\s\S]*is_visible\s*=\s*false/);
  });
});

describe('миграция 1513 скрывает уже записанные советы групп', () => {
  it('только советы из Telegram-групп, без удаления', () => {
    expect(MIGRATION).toMatch(/SET is_visible = false/);
    expect(MIGRATION).toMatch(/category = 'tourist_tip'/);
    expect(MIGRATION).toMatch(/metadata->>'source' = 'telegram_group'/);
    expect(MIGRATION).not.toMatch(/\bDELETE\b/i);
  });
});
