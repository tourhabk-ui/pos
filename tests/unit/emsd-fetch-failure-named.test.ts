// @vitest-environment node
/**
 * Сторож: «не дошли» называет причину, а не «fetch failed».
 *
 * ── Что нашлось 29.09 ─────────────────────────────────────────────────────
 *
 * Watchdog прислал КРИТ о суточной сводке вулканов КФ ЕГС. В теле прогона
 * стояло ровно это:
 *
 *   {"ok":false,"reason":"сводка не получена: TypeError: fetch failed"}
 *
 * Больше прод не знал ничего. У `fetch` в Node сообщение ВСЕГДА одно и то же,
 * а настоящая причина лежит в `cause`: имя не разрешилось, соединение
 * отвергнуто, оборвано, истёк таймаут, не сошёлся сертификат. Чинятся они
 * по-разному — «сайт института лежит» и «с Timeweb закрыли выход» это разные
 * работы, — а выглядели одинаково. Отказ, не назвавший себя, стоит следующему
 * читателю дня разбора (§4.0).
 *
 * Разворачивание причины держится ЗДЕСЬ, а не в каждом месте, где ловится
 * сетевой отказ: второй экземпляр разошёлся бы с первым (§12).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeFetchFailure } from '@/lib/services/safety/emsd-fetch';

describe('причина сетевого отказа доходит до человека', () => {
  it('«fetch failed» дополняется причиной из cause', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND www.emsd.ru'), { code: 'ENOTFOUND' });
    const e = Object.assign(new TypeError('fetch failed'), { cause });
    const why = describeFetchFailure(e);
    expect(why).toContain('TypeError: fetch failed');
    expect(why, 'настоящая причина потеряна').toContain('ENOTFOUND');
    expect(why, 'код ошибки не назван').toContain('[ENOTFOUND]');
  });

  it('цепочка причин разворачивается, а не обрывается на первой', () => {
    const deep = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
    const mid = Object.assign(new Error('socket hang up'), { cause: deep });
    const top = Object.assign(new TypeError('fetch failed'), { cause: mid });
    const why = describeFetchFailure(top);
    expect(why).toContain('socket hang up');
    expect(why).toContain('ECONNREFUSED');
  });

  it('кольцо ссылок не уводит в бесконечность', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(describeFetchFailure(a)).toContain('b');
  });

  it('ошибка без причины остаётся собой, без пустых скобок', () => {
    expect(describeFetchFailure(new Error('обрыв'))).toBe('Error: обрыв');
    expect(describeFetchFailure(new Error('обрыв'))).not.toContain('причина');
  });

  it('не ошибка тоже называется, а не глушится', () => {
    expect(describeFetchFailure('строка вместо ошибки')).toBe('строка вместо ошибки');
  });
});

describe('поход зовёт именно это правило', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/emsd-fetch.ts'), 'utf-8');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  it('сетевой отказ описывается общей функцией, а не склейкой name и message', () => {
    expect(code).toMatch(/const why = describeFetchFailure\(e\)/);
    expect(code, 'причина снова теряется на склейке name и message')
      .not.toMatch(/const why = e instanceof Error \? `\$\{e\.name\}: \$\{e\.message\}`/);
  });

  it('отказ по-прежнему пишется в лог, а не только возвращается', () => {
    expect(code).toMatch(/console\.error\(`\[emsd-fetch\] запрос не дошёл/);
  });
});
