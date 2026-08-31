/**
 * Кузьмич-евал в петле эволюции (Эволюция 3.0, п.6; владелец 08.08:
 * «эволюция»).
 *
 * Faithfulness-евал Кузьмича существовал и алертил в Telegram, но алерт —
 * оперативный сигнал без хвоста: его никто не «брал в работу». Линза
 * scanKuzmichEval читает последний прогон каждого источника (фикстура /
 * живые вопросы) из agent_run_history и превращает плохой итог в находку
 * 'suggested' — тот же путь в GitHub Issues, что у воронки и прод-500.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickKuzmichEvalFinding, type KuzmichEvalRunRow } from '@/lib/agents/evo/growth-agent';

const GROWTH = readFileSync(join(process.cwd(), 'lib/agents/evo/growth-agent.ts'), 'utf-8');

const run = (over: Partial<KuzmichEvalRunRow>): KuzmichEvalRunRow => ({
  agent_id: 'kuzmich-eval', status: 'success', pass_rate: 0.9, wilson_low: 0.75, ...over,
});

describe('pickKuzmichEvalFinding: худший итог — одна находка', () => {
  it('faithfulness ниже порога → высокая находка с цифрами прогона', () => {
    const f = pickKuzmichEvalFinding([run({ status: 'failed', pass_rate: 0.6, wilson_low: 0.42 })]);
    expect(f?.title).toBe('Кузьмич-евал: ответы расходятся с данными');
    expect(f?.severity).toBe('high');
    expect(f?.category).toBe('bug');
    expect(f?.description).toContain('0.6');
    expect(f?.description).toContain('фикстура');
  });

  it('живой источник назван в описании', () => {
    const f = pickKuzmichEvalFinding([run({ agent_id: 'kuzmich-eval-live', status: 'failed', pass_rate: 0.5 })]);
    expect(f?.description).toContain('живые вопросы туристов');
  });

  it('прогон упал целиком (без pass_rate) → отдельная находка о самом евале', () => {
    const f = pickKuzmichEvalFinding([run({ status: 'failed', pass_rate: null, wilson_low: null })]);
    expect(f?.title).toBe('Кузьмич-евал: прогон падает');
    expect(f?.severity).toBe('medium');
  });

  it('судья недоступен (partial) → находка «нечем судить», а не ложное «всё хорошо»', () => {
    const f = pickKuzmichEvalFinding([run({ status: 'partial' })]);
    expect(f?.title).toBe('Кузьмич-евал: судья недоступен');
  });

  it('завал faithfulness перебивает слепого судью — худшее сначала', () => {
    const f = pickKuzmichEvalFinding([
      run({ agent_id: 'kuzmich-eval-live', status: 'partial' }),
      run({ status: 'failed', pass_rate: 0.7 }),
    ]);
    expect(f?.title).toBe('Кузьмич-евал: ответы расходятся с данными');
  });

  it('зелёный прогон и отсутствие прогонов → находки нет (liveness сторожит Watchdog)', () => {
    expect(pickKuzmichEvalFinding([run({})])).toBeNull();
    expect(pickKuzmichEvalFinding([])).toBeNull();
  });

  it('находка детерминированная и сразу suggested — путь в Issues открыт', () => {
    const f = pickKuzmichEvalFinding([run({ status: 'failed', pass_rate: 0.6 })]);
    expect(f?.model).toBe('deterministic');
    expect(f?.status).toBe('suggested');
  });

  it('заголовки стабильны: цифры только в описании (дедуп по title)', () => {
    const a = pickKuzmichEvalFinding([run({ status: 'failed', pass_rate: 0.6 })]);
    const b = pickKuzmichEvalFinding([run({ status: 'failed', pass_rate: 0.3 })]);
    expect(a?.title).toBe(b?.title);
    expect(a?.title).not.toMatch(/\d/);
  });
});

describe('контур подключён', () => {
  it('линза в прочёсе и читает журнал прогонов, а не код', () => {
    // Раньше здесь стояло `scanKuzmichEval().catch(` — проверка «подключён и
    // не роняет прогон» заодно закрепляла ГЛУШИТЕЛЬ отказа. Требование то же,
    // но исполняется через lens, который отказ ещё и называет вслух (§4.0).
    expect(GROWTH).toMatch(/lens\(lenses, 'Кузьмич-евал', scanKuzmichEval/);
    expect(GROWTH).toMatch(/FROM agent_run_history/);
    expect(GROWTH).toMatch(/'kuzmich-eval', 'kuzmich-eval-live'/);
    expect(GROWTH).toMatch(/INTERVAL '8 days'/);
  });

  it('берётся последний прогон каждого источника', () => {
    expect(GROWTH).toMatch(/DISTINCT ON \(agent_id\)/);
    expect(GROWTH).toMatch(/ORDER BY agent_id, started_at DESC/);
  });
});
