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

// Скрытая строка бесполезна, если хоть один читатель для туриста её берёт
// (ревью безопасности #3831: виджет Кузьмича шёл через rag-context без
// фильтра). VIEW agent_route_knowledge отдаёт is_visible, но не фильтрует.
describe('туристские читатели знаний берут только видимое', () => {
  const READERS = ['lib/ai/rag-context.ts', 'lib/ai/embeddings.ts', 'lib/ai/route-knowledge.ts'];

  for (const f of READERS) {
    it(`${f}: каждый SELECT по знаниям маршрутов фильтрует is_visible`, () => {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      const selects = [...src.matchAll(/SELECT[\s\S]*?FROM (agent_route_knowledge|kamchatka_routes)\b[\s\S]*?`/g)].map((m) => m[0]);
      // Ноль найденных — сломался разбор, а не «читателей нет».
      expect(selects.length).toBeGreaterThan(0);
      for (const q of selects) expect(q).toMatch(/is_visible\s*=\s*TRUE/i);
    });
  }
});
