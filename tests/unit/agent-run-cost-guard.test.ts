// @vitest-environment node
/**
 * Стоимость агентского прогона задаётся явно (разбор расходов 06.09).
 *
 * Выгрузка за сутки: $36.4, и это не «много мелочи», а три десятка агентских
 * прогонов на раннере. Два места, где деньги уходили молча, лечатся одинаково
 * — тем, что цена названа в файле, а не досталась по умолчанию:
 *
 *   1. Прогон без `--model` стоит столько, сколько решит умолчание экшена.
 *      У руки и летописца модель названа, у свипера её не было — обновление
 *      пина экшена меняло бы и модель, и счёт, ничего об этом не сказав.
 *   2. Прогон без `--max-turns` не имеет верхней границы вовсе. Прогон 550
 *      ушёл на 70 ходов и 17 минут, и результат был выброшен целиком.
 *
 * Третье правило — про полный набор тестов внутри агента. Он встречался
 * ДВАЖДЫ: в руке (убран утром) и в свипере (найден вечером). Девять тысяч
 * тестов — шесть минут, весь вывод оседает в контексте агента и оплачивается
 * как запись кэша, а ровно то же самое CI прогоняет на пуше второй раз и
 * бесплатно. Сторож нужен именно потому, что формулировка «обязательно
 * прогони npx vitest run» выглядит добросовестной и переписывается снова.
 *
 * Сторож НЕ замораживает выбор модели: какая именно — решение владельца
 * (у руки это Fable 5.1, `issue-hand-model-pinned.test.ts`). Здесь
 * проверяется только то, что выбор СДЕЛАН и записан.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WF_DIR = join(process.cwd(), '.github/workflows');

const agentWorkflows = readdirSync(WF_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ name: f, src: readFileSync(join(WF_DIR, f), 'utf-8') }))
  .filter((w) => w.src.includes('anthropics/claude-code-action'));

describe('агентские прогоны: цена названа, а не досталась по умолчанию', () => {
  it('такие workflow вообще есть — иначе сторож охраняет пустоту', () => {
    expect(agentWorkflows.length).toBeGreaterThan(0);
  });

  for (const { name, src } of agentWorkflows) {
    it(`${name}: модель названа явно`, () => {
      expect(
        src,
        'нет --model: цену определяет умолчание экшена, и смена пина экшена молча меняет счёт',
      ).toMatch(/--model\s+\S+/);
    });

    it(`${name}: потолок ходов задан`, () => {
      const m = src.match(/--max-turns\s+(\d+)/);
      expect(m, 'нет --max-turns: у прогона нет верхней границы вовсе').not.toBeNull();
      // Потолок — граница на случай закружившегося агента, а не бюджет,
      // который надо освоить. Сотня ходов — это уже не граница.
      expect(Number(m?.[1]), 'потолок выше сотни ходов границей не является').toBeLessThanOrEqual(100);
    });

    it(`${name}: агенту не поручен полный набор тестов`, () => {
      // Ищем `vitest run` БЕЗ пути после него — то есть весь набор.
      // `npx vitest run tests/unit/foo.test.ts` правилу не противоречит.
      const offenders = src
        .split('\n')
        .filter((l) => /vitest\s+run\s*(?:$|[^\S\n]*(?:и|&&|;|\.)?\s*$)/.test(l.trim()));
      expect(
        offenders,
        `полный vitest внутри агента: ${offenders.map((l) => l.trim()).join(' | ')}`,
      ).toEqual([]);
    });
  }
});

describe('ревью по метке срабатывает только на СВОЮ метку', () => {
  /**
   * `labeled` приходит на любую метку. Триаж вешает `triaged`, `size-L`,
   * `type-infra`, `evo` — без отбора по имени экономия на `synchronize`
   * обернулась бы ростом числа прогонов.
   */
  const withLabeled = readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => ({ name: f, src: readFileSync(join(WF_DIR, f), 'utf-8') }))
    .filter((w) => /types:\s*\[[^\]]*labeled/.test(w.src))
    // Кто слушает и `synchronize`, и `labeled`, метку использует не как
    // способ перезапуска, а как часть решения (у merge gate ярлык меняет
    // вердикт). Правило адресовано другому случаю: метка вместо
    // `synchronize`, где без отбора по имени экономия обернулась бы ростом.
    .filter((w) => !/types:\s*\[[^\]]*synchronize/.test(w.src));

  for (const { name, src } of withLabeled) {
    it(`${name}: есть отбор по имени метки`, () => {
      expect(
        src,
        'триггер labeled без проверки github.event.label.name запускает работу на каждый ярлык',
      ).toMatch(/github\.event\.label\.name\s*==/);
    });
  }
});
