/**
 * Сторож: размышление, съевшее ответ, лечится повтором, а не понижением судьи.
 *
 * ── Что нашлось (#1428, разбор судьи) ──────────────────────────────────────
 *
 * В отчёте судьи дважды стоит строка:
 *
 *   deepseek(deepseek-v4-pro): пустой ответ — finish_reason=length;
 *   поля message: role,content,reasoning_content; reasoning_content: 11976 зн.
 *
 * Модель думала на 10-12 тысяч знаков, упёрлась в потолок и до ответа не
 * дошла. Надбавка `deepThinkingBudget` (+1500 токенов) калибровалась по
 * задаче, где размышление занимало 575-686 знаков, — в пятнадцать-двадцать
 * раз меньше.
 *
 * ── Почему это не «одна находка не разобрана» ──────────────────────────────
 *
 * Пустой ответ уводил перебор на СЛЕДУЮЩЕГО кандидата, то есть на более
 * слабую модель. Значит на самых длинных и самых трудных находках вердикт
 * выносил слабейший судья — а в отчёте это выглядело строкой в таблице
 * «модель — вердиктов», где у сильной просто меньше число.
 *
 * Инверсия качества, невидимая по построению: чем труднее находка, тем
 * слабее тот, кто её судит.
 *
 * ── Почему именно повтор без размышления ───────────────────────────────────
 *
 * Оба рычага измерены, и выбран не тот, что кажется очевидным:
 *
 *   - `thinking: disabled` ЛЕЧИТ (04.09, ai-debug run 7: ответ за ~320 мс);
 *   - больший потолок НЕ ЛЕЧИТ (12.09): прибавка 2200 токенов сдвинула точку
 *     обрыва меньше чем на 100 знаков — вся ушла в ДОПОЛНИТЕЛЬНОЕ
 *     размышление. Размышление растягивается под бюджет, а не укладывается
 *     в него.
 *
 * Поэтому сторож запрещает «починку потолком»: она уже пробована дважды.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reasoningAteTheAnswer, describeEmptyCompletion } from '@/lib/ai/failure-trace';
import { anthropicModelFromSlug } from '@/lib/ai/providers';

const ROOT = process.cwd();
const PROVIDERS = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');

/** Ответ DeepSeek: думал, упёрся в потолок, ответа нет. */
const ATE = {
  choices: [{
    finish_reason: 'length',
    message: { role: 'assistant', content: '', reasoning_content: 'ж'.repeat(11976) },
  }],
};

describe('подпись «размышление съело ответ» опознаётся точно', () => {
  it('случай #1428 опознан', () => {
    expect(reasoningAteTheAnswer(ATE)).toBe(true);
  });

  it('обычный ответ — не он', () => {
    expect(reasoningAteTheAnswer({
      choices: [{ finish_reason: 'stop', message: { content: 'по делу' } }],
    })).toBe(false);
  });

  it('оборванный, но НЕПУСТОЙ ответ — не он', () => {
    // Потолок кончился уже посреди ответа. Повтор без размышления тут ничего
    // не добавит: текст есть, разбирает его вызывающий.
    expect(reasoningAteTheAnswer({
      choices: [{ finish_reason: 'length', message: { content: 'нача', reasoning_content: 'дум' } }],
    })).toBe(false);
  });

  it('пустой ответ БЕЗ размышления — не он', () => {
    // Фильтр, отказ модели, пустой body. Повтор без размышления не поможет,
    // и платить за него вторым запросом нельзя.
    expect(reasoningAteTheAnswer({
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
    })).toBe(false);
  });

  it('пустой ответ по стоп-причине — не он', () => {
    expect(reasoningAteTheAnswer({
      choices: [{ finish_reason: 'content_filter', message: { content: '', reasoning_content: 'дум' } }],
    })).toBe(false);
  });

  it('мусор вместо тела не роняет проверку', () => {
    for (const junk of [null, undefined, 'строка', 42, {}, { choices: [] }, { choices: null }]) {
      expect(reasoningAteTheAnswer(junk), String(junk)).toBe(false);
    }
  });

  it('разбор немоты по-прежнему называет длину размышления', () => {
    // Диагностика и лечение — разные вещи; появление второй не отменяет первую.
    expect(describeEmptyCompletion(ATE)).toContain('11976');
    expect(describeEmptyCompletion(ATE)).toContain('finish_reason=length');
  });
});

/**
 * Второй след из того же отчёта #1428, и того же рода: смена, сделанная
 * позже, не доехала до старой строки.
 *
 *   anthropic: каталог моделей пуст — id взят из слага OpenRouter
 *   anthropic(z-ai/glm-5.3): HTTP 401 ... "API key is invalid."
 *
 * Запасное имя выводилось как `flagshipModel.replace(/^anthropic\//, '')` —
 * верно ровно до 09.09, пока флагман ВСЕГДА был моделью Anthropic. После того
 * как вендор стал переменной (`EVO_DECISION_FLAGSHIP_VENDOR: z-ai`), replace
 * перестал что-либо снимать, и в api.anthropic.com уходила модель чужого
 * поставщика.
 *
 * Строка выглядела отказом ключа — и именно поэтому её никто не разбирал:
 * рядом стоял настоящий отказ ключа, и второй дефект прятался за первым.
 */
describe('чужой слаг не уходит в Anthropic под видом его модели', () => {
  it('anthropic-слаг превращается в id', () => {
    expect(anthropicModelFromSlug('anthropic/claude-opus-4.6')).toBe('claude-opus-4.6');
  });

  it('слаг другого поставщика — «просить нечего», а не он сам', () => {
    // Ровно случай #1428.
    expect(anthropicModelFromSlug('z-ai/glm-5.3')).toBeNull();
    for (const alien of ['openai/gpt-5.6', 'x-ai/grok-4.6', 'deepseek/deepseek-v4-pro']) {
      expect(anthropicModelFromSlug(alien), alien).toBeNull();
    }
  });

  it('пустой хвост и голое имя без вендора — тоже «нечего»', () => {
    expect(anthropicModelFromSlug('anthropic/')).toBeNull();
    expect(anthropicModelFromSlug('anthropic/   ')).toBeNull();
    expect(anthropicModelFromSlug('')).toBeNull();
    // Похожее имя без разделителя моделью Anthropic не делает.
    expect(anthropicModelFromSlug('anthropic-claude-opus')).toBeNull();
  });

  it('ступень пропускается с НАЗВАННОЙ причиной, а не молча', () => {
    expect(PROVIDERS).toMatch(/не модель Anthropic; просить нечего/);
  });

  it('проба релея не выдаёт «не смогла проверить» за «путь сломан»', () => {
    // Второе такое же место, найденное этим же сторожем. Цена там выше: это
    // диагностика, и её ложный отказ — основание для НЕВЕРНОГО решения.
    expect(PROVIDERS).toMatch(/путь НЕ проверен/);
  });

  it('вывод id из слага больше не размазан по файлу', () => {
    /**
     * Строк было ДВЕ, и вторую (пробу релея) нашёл этот тест, а не глаз:
     * рядом с ней стоял настоящий отказ ключа, и дефект прятался за ним.
     * Правило живёт в одной функции — иначе следующая смена вендора снова
     * доедет не до всех.
     *
     * Комментарии исключены: они НАЗЫВАЮТ прежнюю форму как пример ловушки,
     * и краснеть на собственном объяснении сторож не должен.
     */
    const code = PROVIDERS.split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code, 'replace вернулся — смена вендора снова доедет не до всех')
      .not.toMatch(/flagshipModel\.replace\(\/\^anthropic/);
    expect((code.match(/anthropicModelFromSlug\(/g) ?? []).length)
      .toBeGreaterThanOrEqual(3);   // объявление + оба вызывающих
  });
});

describe('путь решателя повторяет ТОЙ ЖЕ моделью, а не понижает судью', () => {
  it('повтор без размышления есть', () => {
    expect(PROVIDERS, 'подпись не распознаётся — значит перебор уйдёт на слабую модель')
      .toMatch(/reasoningAteTheAnswer\(data\)/);
    expect(PROVIDERS).toMatch(/повтор без размышления/);
  });

  it('повтор отдаёт весь бюджет ответу', () => {
    // При выключенном размышлении надбавка не нужна: резервировать под
    // размышление, которого нет, значит снова отдать потолок не ответу.
    expect(PROVIDERS).toMatch(/think \? deepThinkingBudget\(1500\) : 1500/);
  });

  it('повтор не превращается в бесконечный', () => {
    // Ровно одна попытка: ask(true), затем ask(false). Третьей быть не должно —
    // иначе на молчащей модели прогон встанет колом.
    const leg = PROVIDERS.slice(PROVIDERS.indexOf('const ask = (think: boolean)'));
    const window = leg.slice(0, 2600);
    expect((window.match(/await ask\(/g) ?? []).length).toBe(2);
  });

  it('прочая немота повтором НЕ лечится', () => {
    // Ветка «пустой ответ — ...; пробуем следующую» обязана остаться: без неё
    // каждый молчащий ответ стоил бы двух запросов вместо одного.
    expect(PROVIDERS).toMatch(/пустой ответ — \$\{describeEmptyCompletion\(data\)\}/);
  });

  it('починка потолком не вернулась', () => {
    /**
     * Надбавка измерена дважды и дважды не сработала (12.09). Если кто-то
     * поднимет её в третий раз, тест назовёт причину, а не просто упадёт.
     */
    expect(
      /deepThinkingBudget\(answerTokens: number\): number \{\s*return answerTokens \+ 1500;/.test(
        readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8'),
      ),
      'надбавка изменена: размышление растягивается под бюджет — прибавка 2200 токенов '
      + 'сдвинула обрыв меньше чем на 100 знаков (замер 12.09). Лечится выключением '
      + 'размышления на повторе, а не потолком',
    ).toBe(true);
  });
});
