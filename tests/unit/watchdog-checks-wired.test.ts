/**
 * Сторож состава Watchdog: каждая написанная проверка попадает в прогон.
 *
 * 22.08.2026 в `runWatchdog` пятнадцать вызовов разбирались в четырнадцать
 * имён позиционной деструктуризацией. Лишний уезжал за край молча:
 * `checkFailedMigrations()` выполнялся каждые полчаса, и его результат
 * выбрасывался — тревога «миграция упала» не срабатывала ни разу. Потеря
 * выглядела как тишина, а тишина у сторожа неотличима от «всё хорошо».
 *
 * Проверяется исходник, а не поведение: поднять весь Watchdog в тесте нельзя
 * (он ходит в БД и Telegram), а вопрос здесь чисто структурный — объявлена
 * проверка и не включена в список.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf8');

/** Код без комментариев: имя, упомянутое в пояснении, вызовом не является. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

function declaredChecks(): string[] {
  return [...CODE.matchAll(/^async function (check\w+)\s*\(/gm)].map(m => m[1]);
}

function wiredChecks(): string[] {
  // Тип содержит `=>`, поэтому до `= [` нельзя идти по «любому кроме =».
  const block = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(CODE);
  if (block === null) throw new Error('Список CHECKS в runWatchdog не найден');
  return [...block[1].matchAll(/\b(check\w+)\b/g)].map(m => m[1]);
}

describe('Watchdog: состав проверок', () => {
  it('объявленных проверок больше одной — иначе разбор ниже бессмысленен', () => {
    expect(declaredChecks().length).toBeGreaterThan(5);
  });

  it('каждая объявленная проверка включена в прогон', () => {
    const wired = new Set(wiredChecks());
    const forgotten = declaredChecks().filter(c => !wired.has(c));
    expect(forgotten).toEqual([]);
  });

  it('в списке нет проверки, которой не существует', () => {
    const declared = new Set(declaredChecks());
    const phantom = wiredChecks().filter(c => !declared.has(c));
    expect(phantom).toEqual([]);
  });

  it('результаты не разбираются по позициям — именно там терялась проверка', () => {
    expect(CODE).not.toMatch(/const \[\s*\w+\s*,[\s\S]{0,400}?\]\s*=\s*await Promise\.all/);
  });

  it('падение миграции снова доходит до тревоги', () => {
    expect(wiredChecks()).toContain('checkFailedMigrations');
  });

  it('удержанные платежи проверяются: у /api/cron/payouts планировщик снаружи', () => {
    // Единственный доступный способ узнать, идёт ли внешнее расписание, — след
    // в данных. Убрать эту проверку значит снова остаться без ответа на вопрос
    // «отпускаются ли деньги оператору» (перепись достижимости 22.08).
    expect(wiredChecks()).toContain('checkStuckPayouts');
  });

  it('ни одна проверка не глушит отказ: «не смог» попадает в лог', () => {
    // §4.0: пустой catch превращает поломку в «данных нет», а у сторожа
    // «данных нет» читается как «всё хорошо». 22.08 таких было девять из
    // семнадцати — то есть больше половины сторожевых запросов могли падать
    // беззвучно. Исключений в этом списке нет и заводить их нельзя: место, где
    // нельзя сказать «не знаю», заполняется враньём.
    const names = declaredChecks();
    const starts = names.map(n => ({ n, i: CODE.indexOf(`async function ${n}(`) })).sort((a, b) => a.i - b.i);
    const silent: string[] = [];
    let withCatch = 0;
    for (let k = 0; k < starts.length; k++) {
      const body = CODE.slice(starts[k].i, k + 1 < starts.length ? starts[k + 1].i : CODE.length);
      if (!/catch\s*(\([^)]*\))?\s*\{/.test(body)) continue;
      withCatch++;
      if (!/console\.error/.test(body)) silent.push(starts[k].n);
    }

    // Разбор не вырожден: catch'и он вообще находит — иначе тест зеленел бы на
    // любом коде, включая заведомо неправильный.
    expect(withCatch, 'разбор тел проверок сломался: catch не найден ни в одной').toBeGreaterThan(5);

    expect(
      silent,
      `проверка глушит отказ без записи в лог: ${silent.join(', ')}`,
    ).toEqual([]);
  });
});
