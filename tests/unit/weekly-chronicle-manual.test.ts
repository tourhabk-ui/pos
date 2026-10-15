// @vitest-environment node
/**
 * Летописец запускается только рукой (аудит 15.10, находка A27).
 *
 * Воскресное расписание weekly-chronicle.yml звало платный флагман каждую
 * неделю, а у результата не было потребителя: черновики хроники никто не
 * вливал, .claude/MEMORY.md хроникой не пополнялся с 29.07, прогоны 15 и 17 —
 * failure. Это «объявленный исход без источника» (CLAUDE.md, правило 10.09)
 * с ценой: механизм обещан расписанием, а исполнения нет. Расписание снято,
 * ручной вход (workflow_dispatch и маркер) оставлен.
 *
 * Судится сам артефакт по смыслу: разобранный YAML, ключи `on`, а не форма
 * строки. Описания в AGENTS.md и README.md проверяются только запретом —
 * строка летописца не называет время запуска, которого нет: описание живёт
 * дольше кода, и читающий верит ему.
 *
 * Вернуть расписание — решение владельца вместе с тем, кто черновики вливает;
 * тогда этот сторож меняется тем же коммитом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const WF = '.github/workflows/weekly-chronicle.yml';

/** Ключи `on:` разобранного workflow. js-yaml (YAML 1.2) читает `on` как строку. */
function triggersOf(path: string): Record<string, unknown> {
  const doc = load(readFileSync(join(process.cwd(), path), 'utf8'));
  if (doc === null || typeof doc !== 'object') throw new Error(`${path}: не объект YAML`);
  const on = (doc as Record<string, unknown>).on;
  if (on === null || typeof on !== 'object' || Array.isArray(on)) {
    throw new Error(`${path}: ключ on не словарь`);
  }
  return on as Record<string, unknown>;
}

/** Строка таблицы, где упомянут летописец. */
function chronicleRows(path: string): string[] {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('|') && /Weekly Chronicle/.test(l));
}

describe('летописец без расписания', () => {
  const on = triggersOf(WF);

  it('у workflow нет расписания', () => {
    expect(Object.keys(on)).not.toContain('schedule');
  });

  it('ручной запуск остался: workflow_dispatch', () => {
    expect(Object.keys(on)).toContain('workflow_dispatch');
  });

  it('маркер остался и смотрит в свой файл триггера', () => {
    const push = on.push as { paths?: unknown } | undefined;
    expect(push?.paths).toEqual(['.github/triggers/weekly-chronicle.json']);
  });
});

describe('описания не обещают воскресного прогона', () => {
  for (const doc of ['AGENTS.md', 'README.md']) {
    it(`${doc}: строка летописца есть и не называет время запуска`, () => {
      const rows = chronicleRows(doc);
      expect(rows.length, `${doc}: строка Weekly Chronicle пропала`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row, `${doc}: обещано расписание, которого нет`).not.toMatch(/\d{1,2}:\d{2}\s*UTC/);
      }
    });
  }
});
