/**
 * Сторож цикла инструментов Кузьмича (19.09).
 *
 * Повод. В ночь на 19.09 DeepSeek перестал отвечать с прода: 18.09 в 22:37
 * UTC — HTTP 200 за 3,4 с, через два с половиной часа — сетевой таймаут на
 * 35,7 с. Ключ на месте, не 401 и не 402; отказ внешний. И выяснилось, что
 * ног у `callToolsWaterfall` было две только на бумаге: вторая, OpenRouter,
 * гео-блокируется с прода неделями и отвечает отказом ещё до запроса.
 *
 * Без инструментов Кузьмич не немеет — вызывающий уходит в водопад без tools,
 * — но отвечает он тогда из общих соображений там, где должен был спросить
 * занятость, погоду или профиль безопасности точки. Для платформы, чья цель
 * безопасность туриста, это худший вид отказа: он выглядит как ответ.
 *
 * Второе, что показал разбор: отказ КАЖДОЙ ноги цикла глушился (`catch {
 * return null }`), и снаружи «нет ключа», 403 и таймаут были неразличимы —
 * §4.0 на собственном коде, ровно тот дефект, ради которого заведён
 * lib/ai/failure-trace.ts. Поэтому сторож держит обе вещи разом: число живых
 * ног и то, что ни одна не молчит об отказе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf8');

function waterfallBody(): string {
  const i = SRC.indexOf('export async function callToolsWaterfall(');
  expect(i).toBeGreaterThan(0);
  return SRC.slice(i, SRC.indexOf('\n}', i));
}

function fnBody(name: string): string {
  const i = SRC.indexOf(`export async function ${name}(`);
  expect(i, name).toBeGreaterThan(0);
  return SRC.slice(i, SRC.indexOf('\n}\n', i));
}

/** Ноги цикла: имя провайдера и вызываемая функция, в порядке очереди. */
function legs(): Array<{ provider: string; fn: string }> {
  return [...waterfallBody().matchAll(/provider:\s*'([\w-]+)'[^}]*?run:\s*\(\)\s*=>\s*(\w+)\(/g)]
    .map(m => ({ provider: m[1], fn: m[2] }));
}

describe('цикл инструментов стоит не на одной ноге', () => {
  it('ступеней не меньше трёх', () => {
    // Не «больше одной»: одна из трёх (OpenRouter) с прода заведомо
    // гео-блокируется, и считать её ногой значит повторить 19.09.
    expect(legs().length).toBeGreaterThanOrEqual(3);
  });

  it('ноги ведут в реально объявленные функции, а не в надежду', () => {
    for (const { fn } of legs()) {
      expect(SRC, fn).toContain(`export async function ${fn}(`);
    }
  });

  it('достижимый из РФ провайдер идёт раньше гео-блокируемого', () => {
    // Ступени идут ПОСЛЕДОВАТЕЛЬНО. Заведомо отказывающая впереди живой — это
    // секунды ожидания человека в поле, купленные ни за что (урок Qwen 08.09).
    const order = legs().map(l => l.provider);
    expect(order[0]).toBe('deepseek');
    expect(order.indexOf('xai')).toBeGreaterThan(-1);
    expect(order.indexOf('xai')).toBeLessThan(order.indexOf('openrouter'));
  });

  it('снятый с текстовых путей Qwen в очередь не вернулся', () => {
    expect(legs().map(l => l.provider)).not.toContain('qwen');
  });
});

describe('ни одна нога не молчит об отказе', () => {
  const FNS = ['callDeepSeekWithTools', 'callXaiWithTools', 'callOpenRouterWithTools'];

  for (const fn of FNS) {
    it(`${fn}: у каждого выхода в null названа причина`, () => {
      const body = fnBody(fn);
      // Пустой catch превращает поломку в «ответа нет» — и снаружи это
      // неотличимо от «модель промолчала».
      expect(body, fn).not.toMatch(/catch\s*\{/);
      expect(body, fn).toContain('recordAiLegFailure');
      // Три разных исхода, а не один: нет ключа / HTTP-отказ / исключение.
      expect(body, fn).toContain("'no_key'");
      expect(body, fn).toContain('httpFailureReason(');
      expect(body, fn).toContain('errorFailureReason(');
    });
  }

  it('имена ног в следе отказов различимы по провайдеру', () => {
    for (const fn of FNS) {
      expect(fnBody(fn)).toMatch(/recordAiLegFailure\('[\w-]+:tools'/);
    }
  });
});

describe('xAI зовётся по правилам §8', () => {
  const body = fnBody('callXaiWithTools');

  it('модель резолвится из каталога, а не хардкодится', () => {
    expect(body).toContain('resolveXaiModel(purpose)');
    expect(body).not.toMatch(/model:\s*'grok/i);
  });

  it('первой идёт лёгкая модель: сорок три секунды для поля — «не ответил»', () => {
    // Замер 04.09: grok-4.6 отвечает 43 с, grok-build-0.1 — 13 с.
    expect(body.indexOf("'fast'")).toBeGreaterThan(-1);
    expect(body.indexOf("'fast'")).toBeLessThan(body.indexOf("'strong'"));
  });

  it('сильная модель — вторая попытка, и только после ОТКАЗА СЕРВЕРА', () => {
    // Поддерживает ли лёгкая модель каталога инструменты, отсюда не проверить.
    // Нога без второй попытки могла бы не ответить никогда, и узнать об этом
    // было бы неоткуда — «объявленный исход без источника» (§4).
    expect(body).toContain('httpRefused');
    expect(body).toContain("if (purpose === 'strong' && !httpRefused) break;");
  });

  it('хост xAI уже стоит в замороженном реестре D2', () => {
    const registry = readFileSync(join(process.cwd(), 'lib/agents/compliance/provider-registry.ts'), 'utf8');
    expect(registry).toContain('api.x.ai');
  });
});
