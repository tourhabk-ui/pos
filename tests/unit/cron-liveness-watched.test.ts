/**
 * Сторож наблюдения за живостью кронов (19.09).
 *
 * Повод. Владелец переслал предупреждение «DeepSeek недоступен». Разбор
 * показал, что предупреждению три часа: крон `health` объявлен в реестре как
 * «каждый час», а между его прогонами в ту ночь набегало от 2ч37м до 5ч34м,
 * и с 01:14 до 04:25 UTC не прошёл ни один. Заметить это было нечем —
 * liveness-сторож отбирал `tier === 'safety'`, а `health` в разряде `ops`.
 *
 * Механизм дефекта важнее случая. Отбор был записан условием на месте
 * (`tier === 'safety' && ...`), а условие не говорит, кто остался снаружи.
 * Снаружи осталось семь восьмых реестра, и молчание любого из них было
 * неотличимо от исправной работы — ровно §4.0: место, где нельзя сказать
 * «не наблюдается», заполняется зелёным.
 *
 * Здесь проверяется СВЯЗКА, а не половина (§4 «объявленный исход без
 * источника»): у каждого исхода `livenessWatch` есть потребитель в
 * watchdog.ts, и ни одна запись реестра не выпадает из разбиения молча.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { livenessWatch, type LivenessWatch } from '@/lib/agents/cron-liveness';

const WATCHDOG = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf8');

describe('разбиение реестра по сторожам живости', () => {
  it('у каждой записи реестра есть исход, и он один из четырёх', () => {
    const allowed: LivenessWatch[] = ['safety', 'nonsafety', 'no_telemetry', 'watched_elsewhere'];
    for (const e of CRON_REGISTRY) {
      expect(allowed, e.key).toContain(livenessWatch(e));
    }
  });

  it('инструментированный крон не остаётся без наблюдения без ИМЕНИ причины', () => {
    // 'no_telemetry' — честное «сказать нечем»; 'watched_elsewhere' обязано
    // называть это «другое место» в шапке livenessWatch. Всё остальное,
    // у чего есть agentId, обязано попасть под одного из двух сторожей.
    const unwatched = CRON_REGISTRY
      .filter(e => e.agentId !== null && livenessWatch(e) === 'no_telemetry')
      .map(e => e.key);
    expect(unwatched).toEqual([]);
  });

  it('вне безопасности наблюдается БОЛЬШИНСТВО реестра — иначе починка 19.09 отменена', () => {
    const nonsafety = CRON_REGISTRY.filter(e => livenessWatch(e) === 'nonsafety');
    const safety = CRON_REGISTRY.filter(e => livenessWatch(e) === 'safety');
    expect(safety.length).toBeGreaterThan(0);
    // Цифра не точная, а порядковая: до 19.09 наблюдаемых было шесть на весь
    // реестр. Порог ловит возврат к отбору «только безопасность».
    expect(nonsafety.length).toBeGreaterThan(safety.length);
  });

  it('исключения названы поимённо и обоснованы в коде, а не в этом тесте', () => {
    const elsewhere = CRON_REGISTRY.filter(e => livenessWatch(e) === 'watched_elsewhere').map(e => e.agentId);
    expect(elsewhere.sort()).toEqual(['safety-ingest', 'watchdog']);
    // У сейсмо-приёмника действительно есть свой, более строгий сторож.
    expect(WATCHDOG).toContain('async function checkSeismicCronDead');
  });
});

describe('у каждого исхода есть потребитель', () => {
  it('watchdog спрашивает обе наблюдаемые доли', () => {
    expect(WATCHDOG).toContain("livenessWatch(e) === 'safety'");
    expect(WATCHDOG).toContain("livenessWatch(e) === 'nonsafety'");
  });

  it('оба сторожа живости включены в прогон', () => {
    const block = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(WATCHDOG);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('checkDeadSafetyCrons');
    expect(block![1]).toContain('checkDeadNonSafetyCrons');
  });

  it('счёт молчащих один на обоих — копии этого правила уже расходились', () => {
    expect(WATCHDOG).toContain('async function silentCronsIn(');
    // Порог задержки GitHub Actions остаётся один и живёт в счёте, а не в
    // вызывающих: два порога на одно правило — это два разных правила.
    const body = WATCHDOG.slice(WATCHDOG.indexOf('async function silentCronsIn('));
    expect(body.slice(0, 2000)).toContain('GITHUB_DELAY_FLOOR_MIN');
  });

  it('дебаунс считается по составу, а не по возрасту молчания', () => {
    // «не отмечался 5ч» через час станет «6ч», хэш details изменится, и
    // стоячее условие пошло бы в Telegram каждый час вместо раза в 12.
    expect(WATCHDOG).toContain('debounceOn?: string;');
    expect(WATCHDOG).toContain('a.debounceOn ?? a.details');
    const uses = [...WATCHDOG.matchAll(/debounceOn: labels\.join\('\|'\)/g)];
    expect(uses.length).toBe(2);
  });

  it('молчание вне безопасности не доходит до КРИТ', () => {
    // Иначе редакторский крон, вставший на ночь, закрывает собой сейсмику.
    const i = WATCHDOG.indexOf('async function checkDeadNonSafetyCrons(');
    expect(i).toBeGreaterThan(0);
    const body = WATCHDOG.slice(i, i + 1900);
    expect(body).toContain('critical: false');
    expect(body).not.toContain('SAFETY_CRON_CRITICAL_MIN');
  });
});
