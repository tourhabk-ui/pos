/**
 * tests/unit/kuzmich-eval-skip-reason.test.ts
 *
 * Прогон eval Кузьмича называет, ПОЧЕМУ он не довёл дело до конца.
 *
 * ── Что случилось (08.09) ──────────────────────────────────────────────────
 *
 * Watchdog: «Kuzmich Faithfulness Eval — 9 прогонов подряд без результата,
 * успеха не было за всё окно, причина пропуска не записана». Последние четыре
 * слова и есть дефект: тревога зовёт разбираться и не говорит куда.
 *
 * Причина существовала — в коде роута она вычислялась как выбор статуса, — но
 * в журнал уезжал только статус. `partial` от молчащего судьи и `failed` от
 * плохих ответов Кузьмича чинятся в РАЗНЫХ местах: первое у провайдера,
 * второе в ответах. Общий ключ `skip_reason` Watchdog читает у любого крона
 * (lib/agents/cron-fruitless) — его и не было.
 *
 * Хуже был третий выход. `source=live` без набранных вопросов возвращал
 * вежливую записку в HTTP-ответе и НЕ писал в журнал вовсе. Ответ живёт до
 * конца запроса; после него «крон отработал и спрашивать было нечего» и «крон
 * не запускался» выглядят одинаково — то есть отсутствие следа выдаётся за
 * отсутствие события (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatFruitlessCrons } from '@/lib/agents/cron-fruitless';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/kuzmich-eval/route.ts'), 'utf-8');

describe('каждый исход прогона несёт причину', () => {
  it('судья молчит — judge_unavailable, а не безымянный partial', () => {
    expect(SRC).toMatch(/judgeMostlySilent\s*\n?\s*\?\s*'judge_unavailable'/);
  });

  it('ответы плохи — отдельный код, не тот же, что у молчащего судьи', () => {
    // Граница смысла: «не смог проверить» и «проверил, плохо» — разные исходы
    // с разной починкой. Один код на оба вернул бы ровно ту слепоту, из-за
    // которой владелец три недели чинил промпт при мёртвых провайдерах.
    expect(SRC).toMatch(/'pass_rate_below_threshold'/);
  });

  it('успешный прогон причины не выдумывает', () => {
    // null, а не строка-заглушка: у успеха причины пропуска нет, и писать
    // туда что-нибудь значило бы заполнить пустое место выдумкой.
    expect(SRC).toMatch(/:\s*\(report\.pass_rate >= 0\.8 \? null : 'pass_rate_below_threshold'\)/);
  });

  it('падение прогона тоже названо', () => {
    expect(SRC).toMatch(/skip_reason: 'run_threw'/);
  });

  it('доля немоты судьи уезжает в журнал вместе с причиной', () => {
    // Без неё «judge_unavailable» не отличить от «судья ответил на 69%».
    expect(SRC).toMatch(/judge_unavailable_ratio: report\.judge_unavailable_ratio/);
  });
});

describe('пропуск живого прогона оставляет след', () => {
  it('нет живых вопросов — запись в журнал, а не только записка в ответе', () => {
    const branch = SRC.slice(SRC.indexOf('if (questions.length === 0)'), SRC.indexOf('report = await runKuzmichFaithfulnessEval({ questions })'));
    expect(branch).toMatch(/logAgentRun\(/);
    expect(branch).toMatch(/skip_reason: 'no_live_questions'/);
  });

  it('пропуск не выдаётся за успех', () => {
    const branch = SRC.slice(SRC.indexOf('if (questions.length === 0)'), SRC.indexOf('report = await runKuzmichFaithfulnessEval({ questions })'));
    expect(branch).toMatch(/status: 'partial'/);
    expect(branch).not.toMatch(/status: 'success'/);
  });
});

describe('тревога говорит по-человечески', () => {
  it('код причины переводится словарём', () => {
    const line = formatFruitlessCrons([{
      key: 'kuzmich-eval',
      label: 'Kuzmich Faithfulness Eval',
      runs: 9,
      daysSinceSuccess: null,
      dominantReason: 'pass_rate_below_threshold',
      detail: null,
    }]);
    expect(line).toContain(SKIP_REASON_LABELS.pass_rate_below_threshold);
    expect(line).not.toContain('pass_rate_below_threshold');
  });

  it('незнакомый код показывается как есть — сырой код честнее «неизвестно»', () => {
    const line = formatFruitlessCrons([{
      key: 'x', label: 'X', runs: 3, daysSinceSuccess: 2,
      dominantReason: 'какой_то_новый_код', detail: null,
    }]);
    expect(line).toContain('какой_то_новый_код');
  });

  it('причины нет — так и сказано, а не подставлена похожая', () => {
    const line = formatFruitlessCrons([{
      key: 'x', label: 'X', runs: 3, daysSinceSuccess: 2, dominantReason: null, detail: null,
    }]);
    expect(line).toContain('причина пропуска не записана');
  });
});
