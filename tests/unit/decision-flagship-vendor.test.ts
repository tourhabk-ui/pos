/**
 * Флагман решателя объявляется ОДИН раз и совпадает с тем, что написано в
 * правилах.
 *
 * ── Чем это оплачено ───────────────────────────────────────────────────────
 *
 * Решателя эволюции считают два workflow — судья находок и AI-ревью. Пока
 * вендор флагмана стоял умолчанием в коде, они были согласованы даром; с
 * того дня, как он задаётся в каждом файле отдельно (09.09, перевод на z.ai
 * ради цены), согласованность стала возможностью, а не фактом. Разойдись
 * они — судья и ревью считали бы РАЗНЫМИ моделями, а отчёт бы об этом не
 * сказал: обе ступени называются «флагман».
 *
 * Вторая половина сторожа — про документацию. Цена, ради которой сделан
 * перевод, записана в CLAUDE.md вместе с именем вендора. Если завтра
 * вендора поменяют в workflow, а строку в правилах забудут, файл начнёт
 * врать про то, чем считает платформа, — а именно этим файлом сверяются,
 * когда разбирают качество находок.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const DECIDER_WORKFLOWS = [
  '.github/workflows/evo-judge.yml',
  '.github/workflows/evo-review.yml',
];

function declaredVendor(src: string): string | null {
  const m = src.match(/^\s*EVO_DECISION_FLAGSHIP_VENDOR:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

describe('вендор флагмана решателя', () => {
  it('объявлен в обоих workflow решателя', () => {
    for (const p of DECIDER_WORKFLOWS) {
      expect(declaredVendor(read(p)), `нет EVO_DECISION_FLAGSHIP_VENDOR в ${p}`).toBeTruthy();
    }
  });

  it('у судьи и у ревью он ОДИН и тот же', () => {
    const vendors = DECIDER_WORKFLOWS.map((p) => declaredVendor(read(p)));
    expect(new Set(vendors).size, `разные вендоры: ${vendors.join(' / ')}`).toBe(1);
  });

  it('тот же вендор назван в CLAUDE.md', () => {
    const vendor = declaredVendor(read(DECIDER_WORKFLOWS[0]));
    expect(vendor).toBeTruthy();
    // Правила — не украшение: ими сверяются, когда разбирают качество находок.
    expect(read('CLAUDE.md')).toContain(`EVO_DECISION_FLAGSHIP_VENDOR: ${vendor}`);
  });

  it('id модели в workflow НЕ прибивается', () => {
    // §8: подбор идёт оценкой каталога, а не перечнем. Пин конкретной модели
    // устаревает молча — каталог обновится, а мы останемся на прошлой.
    for (const p of DECIDER_WORKFLOWS) {
      expect(read(p), p).not.toMatch(/EVO_DECISION_FLAGSHIP_MODEL:/);
    }
  });
});
