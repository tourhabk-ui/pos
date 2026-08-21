/**
 * Словарь харнеса в AGENTS.md не разъезжается с репозиторием.
 *
 * Раздел объясняет назначение частей системы и называет их адреса. Документ,
 * который уверенно ссылается на несуществующие файлы, — это не документация, а
 * тот самый дефект, который мы ловим весь август: текст выглядит знающим, а
 * проверить его нечем.
 *
 * Отдельно закреплены три поправки, купленные опытом: без них словарь
 * превращается в пересказ рекламной статьи.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = readFileSync(join(process.cwd(), 'AGENTS.md'), 'utf-8');

/** Пути, названные в таблице словаря и в поправках. */
const NAMED_PATHS = [
  'CLAUDE.md',
  '.claude/DESIGN_SYSTEM.md',
  'scripts/evo-judge.ts',
  '.github/workflows/claude.yml',
  'lib/ai/model-resolver.ts',
  'lib/agents/compliance/provider-registry.ts',
  'lib/security/pii-redact.ts',
  'lib/agents/evo/issue-reporter.ts',
];

describe('словарь харнеса описывает существующее', () => {
  it('раздел на месте', () => {
    expect(DOC).toMatch(/словарь харнеса/i);
  });

  it('названы все четыре компонента', () => {
    for (const c of ['System Prompt', 'Tools', 'Agentic Loop', 'Translation Layer']) {
      expect(DOC, `компонент «${c}» пропал из таблицы`).toContain(c);
    }
  });

  it('каждый названный адрес существует в репозитории', () => {
    const missing = NAMED_PATHS.filter((p) => !existsSync(join(process.cwd(), p)));
    expect(missing, 'словарь ссылается на то, чего нет').toEqual([]);
  });

  it('адреса из словаря действительно упомянуты в документе', () => {
    // Обратная сторона: список выше не должен молча разойтись с текстом.
    const notMentioned = NAMED_PATHS.filter((p) => !DOC.includes(p));
    expect(notMentioned, 'путь есть в тесте, но исчез из AGENTS.md').toEqual([]);
  });
});

describe('поправки, купленные опытом, не вычищаются как «лишнее»', () => {
  it('сменная модель — не равная модель', () => {
    // Разбор 19.08: единственное «по делу» вынес deepseek-v4-flash и ошибся.
    expect(DOC).toMatch(/deepseek-v4-flash/);
    expect(DOC).toMatch(/подписывается рядом с каждым/);
  });

  it('локальность данных решается реестром юрисдикций, а не нейтральностью', () => {
    expect(DOC).toMatch(/152-ФЗ/);
    expect(DOC).toMatch(/provider-registry/);
  });

  it('слабое звено цикла названо прямо', () => {
    expect(DOC).toMatch(/Credit balance is too low/);
  });

  it('сказано, чем мы НЕ владеем', () => {
    // Без этого раздел читается как «у нас всё под контролем».
    expect(DOC).toMatch(/Не владеем/);
  });
});
