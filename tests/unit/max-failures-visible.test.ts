/**
 * Отказ MAX-канала виден, а не растворяется в логе контейнера.
 *
 * Владелец 06.08: «MAX канал не публикует новости». Проверить это было нечем:
 * все зеркала в MAX — fire-and-forget с console.error, который уходит в лог
 * Timeweb и не читается никем. Сколько постов не дошло и почему — неизвестно
 * в принципе. Диагноза нет — значит и починки нет; годами может «работать»
 * канал, в который ничего не приходит.
 *
 * Сторож держит: каждый отказ ложится в ai_actions_log с причиной, ответ MAX
 * читается текстом (не-JSON при отказе не прячет настоящую причину за
 * «Unexpected end of JSON input» — урок сохранения тура 05.08), а у админа
 * есть прямой тест MAX с сырой причиной отказа.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CHANNEL = readFileSync(join(ROOT, 'lib/notifications/telegram-channel.ts'), 'utf-8');
const TEST_ROUTE = readFileSync(join(ROOT, 'app/api/admin/channels/test/route.ts'), 'utf-8');
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('отказ MAX записывается', () => {
  const src = code(CHANNEL);

  it('каждый исход-отказ проходит через recordMaxFailure', () => {
    expect(src).toMatch(/async function recordMaxFailure/);
    // Три пути отказа: env не настроен, MAX ответил ошибкой, fetch упал.
    const calls = src.match(/await recordMaxFailure\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('запись — в ai_actions_log с причиной', () => {
    expect(src).toMatch(/max_post_failed/);
    expect(src).toMatch(/error: error\.slice/);
  });

  it('ответ MAX читается текстом — не-JSON не прячет причину', () => {
    expect(src).toMatch(/await res\.text\(\)/);
    expect(src).toMatch(/HTTP \$\{res\.status\}/);
  });

  it('отсутствие env называется по имени переменной', () => {
    // «MAX не настроен» без имени — снова гадание, какой из двух env пуст.
    expect(src).toMatch(/MAX_BOT_TOKEN/);
    expect(src).toMatch(/MAX_CHANNEL_ID/);
  });
});

describe('админский тест MAX', () => {
  const src = code(TEST_ROUTE);

  it('тип max существует и зовёт maxChannelPost напрямую', () => {
    expect(src).toMatch(/'max'/);
    expect(src).toMatch(/await maxChannelPost\(/);
  });

  it('доступ только администратору', () => {
    expect(src).toMatch(/requireAdmin/);
  });
});
