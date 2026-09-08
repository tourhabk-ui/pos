/**
 * tests/unit/deepseek-reasoning-budget.test.ts
 *
 * Пустой ответ рассуждающей модели называет свою причину.
 *
 * ── Что случилось (прогон подбора 2, 08.09) ────────────────────────────────
 *
 * DeepSeek ответил за 63.7 с моделью `deepseek-v4-pro`. Счётчики:
 * `max_tokens: 4000`, `completion_tokens: 4000`, из них
 * `reasoning_tokens: 4000`. Весь потолок ушёл в РАССУЖДЕНИЕ — на сам ответ не
 * осталось ни одного токена.
 *
 * Скрипт получил пустую строку и сказал «модель ответила не-JSON». Формально
 * верно, по смыслу — ложный след: он зовёт чинить ПРОМПТ при совершенно
 * исправной модели. Ровно та же болезнь, что уже стоила три недели на судье
 * фактчека 22.08, когда заглушку водопада принимали за прозу модели.
 *
 * ── Что здесь чинится ──────────────────────────────────────────────────────
 *
 * У рассуждающих моделей потолок делится между размышлением и ответом, и
 * размышление берёт своё первым. Значит потолок ставится не «сколько нужно на
 * ответ», а «на ответ плюс размышление о нём». И пустота разбирается там, где
 * ещё видны счётчики: дальше по потоку она неотличима от прозы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainEmptyAnswer } from '@/scripts/source-discovery-runner';

const SRC = readFileSync(join(process.cwd(), 'scripts/source-discovery-runner.ts'), 'utf-8');

describe('причина пустого ответа читается по счётчикам', () => {
  it('рассуждение съело потолок — так и сказано, и промпт назван непричастным', () => {
    // Дословный случай прогона 2.
    const why = explainEmptyAnswer(
      { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } },
      4000,
    );
    expect(why).toMatch(/потолок 4000 токенов целиком ушёл в рассуждение/);
    expect(why).toMatch(/промпт тут ни при чём/);
  });

  it('потолок выбран не впритык — рассуждение чуть меньше потолка тоже ловится', () => {
    const why = explainEmptyAnswer(
      { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3990 } },
      4000,
    );
    expect(why).toMatch(/ушёл в рассуждение/);
  });

  it('модель не выдала ничего — это другая беда и другие слова', () => {
    const why = explainEmptyAnswer({ completion_tokens: 0 }, 16000);
    expect(why).toMatch(/ни одного токена/);
    expect(why).not.toMatch(/рассуждение/);
  });

  it('счётчиков нет — «причина не читается», а не выдуманная причина', () => {
    // Третье состояние: не знать причину и назвать неверную — разные вещи.
    const why = explainEmptyAnswer(null, 16000);
    expect(why).toMatch(/причина по счётчикам не читается/);
  });

  it('рассуждения не было, а ответ пуст — на рассуждение не сваливаем', () => {
    const why = explainEmptyAnswer(
      { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 0 } },
      16000,
    );
    expect(why).not.toMatch(/рассуждение/);
  });
});

describe('поставляемый код', () => {
  it('потолок поднят и назван константой с объяснением', () => {
    expect(SRC).toMatch(/const DEEPSEEK_MAX_TOKENS = 16000/);
    expect(SRC).toMatch(/max_tokens: DEEPSEEK_MAX_TOKENS/);
  });

  it('пустота разбирается там, где видны счётчики', () => {
    // Дальше по потоку пустой ответ неотличим от прозы, и разбираться пошли бы
    // в промпт — то есть не туда.
    expect(SRC).toMatch(/if \(!answer\.trim\(\)\) \{[\s\S]{0,200}explainEmptyAnswer/);
  });

  it('в сообщении названы и модель, и причина', () => {
    expect(SRC).toMatch(/DeepSeek \(\$\{model\}\) вернул пустой ответ/);
  });
});
