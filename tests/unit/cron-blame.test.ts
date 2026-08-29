/**
 * Сторож: молчание крона не сваливают на доказанно исправное.
 *
 * ── Что случилось 29.08 ───────────────────────────────────────────────────
 *
 * Watchdog прислал КРИТ по четырём safety-кронам с советом «Проверь GitHub
 * Actions и CRON_SECRET». Оба адреса были заведомо чистыми: все прогоны в
 * Actions зелёные, а секретом в ту же минуту успешно ходили другие кроны.
 * Сломана была доставка расписания — GitHub не запускал джобы.
 *
 * Совет выводился из ЧИСЛА МИНУТ: «сверх 6 часов задержкой расписания быть
 * не может». Посылка была верна в июле и молча устарела к концу августа,
 * когда наблюдаемая задержка выросла до суток. Длительность молчания о
 * причине молчания не говорит ничего.
 *
 * Улика вместо порога: CRON_SECRET один на весь префикс `/api/cron/*`,
 * поэтому один свежий прогон ЛЮБОГО крона доказывает секрет для всех сразу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { blameSilentCrons, describeBlame, WITNESS_FRESH_MIN } from '@/lib/agents/cron-blame';

describe('свидетель снимает подозрение с секрета', () => {
  it('свежий прогон другого крона — виноват планировщик', () => {
    const b = blameSilentCrons({ agentId: 'editor', minutesAgo: 4 }, 400);
    expect(b.kind).toBe('scheduler');
    expect(describeBlame(b)).toContain('editor');
  });

  it('совет НЕ отправляет проверять секрет, который доказанно жив', () => {
    // Ровно та ошибка 29.08: КРИТ звал проверить CRON_SECRET, которым в ту же
    // минуту успешно ходили другие кроны.
    const text = describeBlame(blameSilentCrons({ agentId: 'editor', minutesAgo: 4 }, 400));
    expect(text).toMatch(/исправн/);
    expect(text, 'совет снова гонит проверять исправный секрет').not.toMatch(/проверь CRON_SECRET/i);
  });

  it('молчат все кроны — общий отказ, секрет под подозрением по делу', () => {
    const b = blameSilentCrons({ agentId: 'editor', minutesAgo: WITNESS_FRESH_MIN + 1 }, 400);
    expect(b.kind).toBe('platform');
    expect(describeBlame(b)).toMatch(/CRON_SECRET/);
  });

  it('истории нет вовсе — «не смог установить», а не выбор наугад', () => {
    // §4.0: третий исход отдельный. Изнутри прода «GitHub не запускал» и
    // «запускал, но получил 401» неразличимы — строки не остаётся в обоих
    // случаях. Без свидетеля честный ответ один: не знаю.
    const b = blameSilentCrons(null, 400);
    expect(b.kind).toBe('unknown');
    const text = describeBlame(b);
    expect(text).toMatch(/не смог/i);
    expect(text, 'без данных назван виноватый').not.toMatch(/планировщик GitHub не стартовал/);
  });

  it('вердикт не зависит от длительности молчания', () => {
    // Именно эта зависимость и была дефектом: один и тот же живой свидетель
    // должен давать один и тот же вердикт и на пятнадцати минутах, и на сутках.
    const w = { agentId: 'editor', minutesAgo: 3 };
    expect(blameSilentCrons(w, 15).kind).toBe(blameSilentCrons(w, 1440).kind);
  });
});

describe('watchdog больше не судит по порогу минут', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

  /**
   * Судим КОД, а не комментарии. Разбор случившегося живёт в комментариях
   * рядом с правкой — так принято в этом репозитории, — и цитата снятой
   * формулировки там обязана быть разрешена: иначе сторож запрещал бы
   * объяснять, что именно было снято и почему.
   */
  const CODE = SRC.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('совета «проверь CRON_SECRET» по числу минут в сторожe нет', () => {
    expect(CODE, 'вернулась развилка по порогу вместо улики')
      .not.toMatch(/Проверь GitHub Actions и CRON_SECRET/);
    expect(CODE).not.toMatch(/проверь GitHub Actions\/CRON_SECRET/);
  });

  it('снято утверждение «это уже не задержка расписания»', () => {
    // 29.08 оно было ложным: доставка шла раз в 6.5 часов ИМЕННО из-за
    // расписания. Порог не улика.
    expect(CODE).not.toMatch(/Это уже не задержка расписания/);
  });

  it('оба сторожа молчания зовут вердикт, а не сочиняют совет', () => {
    expect(CODE).toMatch(/describeBlame\(/);
    expect(CODE).toMatch(/readCronWitness\(\)/);
  });
});
