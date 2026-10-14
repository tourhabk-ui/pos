/**
 * Вторая партия переписи дневников (14.10, слово владельца «2 да»; миграция
 * 1249): пять мест парка «Налычево», о которых у сайта парка есть свои
 * строки, получают справку вместо снятой 1247 путевой заметки.
 *
 * Держится:
 *  - справка ложится только в пустое описание и только поверх того самого
 *    дневника, что снят 1247 (начало дневника сверено с реестром 1247);
 *  - голос — справка, не заметка; суть не перетирает записанную;
 *  - перевал и Верблюд говорят о зоне свободного посещения, как режим 1248;
 *  - высота Верблюда — со ссылкой на парк, у Авачинского высоты нет вовсе
 *    (источники расходятся: 2741 и 2751).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { descriptionVoice } from '@/lib/places/description-voice';

const ROOT = process.cwd();
const strip = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const BODY = strip(readFileSync(join(ROOT, 'migrations/1249_nalychevo_diaries_by_park_sources.sql'), 'utf-8'));
const WITHDRAWN = strip(readFileSync(join(ROOT, 'migrations/1247_place_diary_descriptions_withdrawn.sql'), 'utf-8'));
const STATEMENTS = BODY.split(/;\s*\n/).filter((s) => /UPDATE places/.test(s));

/** Склеенное значение `field = '…' || E'\n' || '…'` из оператора. */
function literalOf(stmt: string, field: string): string {
  const part = stmt.split(new RegExp(`(?<![a-z_])${field}\\s*=`))[1].split(/,\s*\n\s*[a-z_]+\s*=|\n\s*WHERE/)[0];
  return [...part.matchAll(/E'\\n'|'((?:[^']|'')*)'/g)]
    .map((m) => (m[0] === "E'\\n'" ? '\n' : m[1].replace(/''/g, "'")))
    .join('');
}

const IDS: Record<string, string> = {
  '3dd2ceaf-1351-4625-9171-711eb8b1a455': 'Авачинский перевал',
  '32aa0d20-10d9-4fbb-a1f7-b90f327b7687': 'Экструзия Верблюд',
  '3a98a68d-76c8-4835-8d6d-24f7dd867cb8': 'Вулкан Авачинский',
  '4baebe00-d71b-4f53-b0bb-0f20b16f1747': 'Краеведческие источники',
  '05112df7-54f9-4280-bcd2-1bfe4929dfc0': 'Фумарола вулкана Дзендзур',
};
const stmtOf = (id: string) => STATEMENTS.find((s) => s.includes(`'${id}'`) && /\n\s*description\s*=/.test(s))!;
/** Начало дневника, записанное 1247 для этого места. */
const headOf = (id: string) => new RegExp(`\\('${id}', '((?:[^']|'')*)'\\)`).exec(WITHDRAWN)?.[1].replace(/''/g, "'") ?? null;

describe('миграция 1249', () => {
  it('пять мест, у каждого — своя справка', () => {
    for (const id of Object.keys(IDS)) expect(stmtOf(id), IDS[id]).toBeTruthy();
  });

  it('справка только в пустое описание и только поверх дневника, снятого 1247', () => {
    for (const id of Object.keys(IDS)) {
      const s = stmtOf(id);
      expect(s, IDS[id]).toMatch(/AND description IS NULL/);
      const like = /AND description_withdrawn LIKE '((?:[^']|'')*)%'/.exec(s)?.[1];
      const head = headOf(id);
      expect(head, `${IDS[id]}: в реестре 1247`).not.toBeNull();
      expect(head!.startsWith(like!), `${IDS[id]}: «${like}» — начало «${head}»`).toBe(true);
    }
  });

  it('голос справки; суть ложится, только если её не было', () => {
    for (const id of Object.keys(IDS)) {
      const s = stmtOf(id);
      expect(descriptionVoice(literalOf(s, 'description')).voice, IDS[id]).toBe('plain');
      expect(s, IDS[id]).toMatch(/essence = COALESCE\(essence,/);
      expect(s, IDS[id]).toMatch(/source_name = COALESCE\(source_name, 'сайт парка «Вулканы Камчатки»/);
    }
  });

  it('перевал и Верблюд — зона свободного посещения, как режим 1248', () => {
    for (const id of ['3dd2ceaf-1351-4625-9171-711eb8b1a455', '32aa0d20-10d9-4fbb-a1f7-b90f327b7687']) {
      expect(literalOf(stmtOf(id), 'description')).toMatch(/зон[аеы] свободного посещения/);
      expect(literalOf(stmtOf(id), 'description')).toMatch(/разрешение на посещение не требуется/);
    }
  });

  it('высоты: у Верблюда — со ссылкой на парк, у Авачинского — нет', () => {
    expect(literalOf(stmtOf('32aa0d20-10d9-4fbb-a1f7-b90f327b7687'), 'description'))
      .toMatch(/Абсолютная высота скалы, по данным природного парка «Налычево», — 1250 метров/);
    expect(literalOf(stmtOf('3a98a68d-76c8-4835-8d6d-24f7dd867cb8'), 'description')).not.toMatch(/27[45]1/);
  });
});
