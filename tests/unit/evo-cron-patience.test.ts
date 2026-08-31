/**
 * Терпение вызывающего должно быть БОЛЬШЕ собственного бюджета роута.
 *
 * 03.08 лимит подняли 180 → 300, и это было верно тогда, но создало
 * равенство: у `/api/cron/evo` `maxDuration = 300`, и воркфлоу сдавался
 * ровно в ту же секунду, когда серверу ещё только разрешено работать.
 * Запаса не осталось вообще, а два разных исхода — «сервер не уложился в
 * свой бюджет» и «мы не дождались того, что ещё шло» — стали неразличимы
 * по построению.
 *
 * Замер аудита 30.08: прогоны 366-369 занимали 7-180 с, прогоны 370-373 —
 * ровно 300+ с с exit 28. Стена таймаута, а не рост нагрузки. И ни одной
 * строки в логе: шаг идёт под `bash -e`, отказ curl убивал скрипт до вывода.
 *
 * Здесь сверяются ДВА ЧИСЛА ИЗ ИСТОЧНИКОВ, а не из копии в тесте: если
 * кто-то поднимет maxDuration роута и забудет воркфлоу, сторож покраснеет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(join(process.cwd(), '.github/workflows/cron-evo.yml'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/evo/route.ts'), 'utf-8');

/** Код шага без строк-комментариев: пояснение вызовом не является. */
const STEP = WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

function routeBudget(): number {
  const m = /export const maxDuration\s*=\s*(\d+)/.exec(ROUTE);
  expect(m, 'maxDuration в app/api/cron/evo/route.ts не найден').not.toBeNull();
  return Number(m![1]);
}

function clientPatience(): number {
  const m = /--max-time\s+(\d+)/.exec(STEP);
  expect(m, '--max-time в cron-evo.yml не найден').not.toBeNull();
  return Number(m![1]);
}

describe('cron-evo: запас против бюджета роута', () => {
  it('терпение воркфлоу строго больше maxDuration роута', () => {
    const budget = routeBudget();
    const patience = clientPatience();
    expect(
      patience,
      `равенство ${patience} = ${budget} и есть дефект E-1: исходы «сервер не уложился» и «мы не дождались» становятся неразличимы`,
    ).toBeGreaterThan(budget);
  });

  it('запаса хватает, чтобы отличить один исход от другого', () => {
    // Слишком тонкий запас вернул бы ту же неразличимость с точностью до
    // сетевой задержки.
    expect(clientPatience() - routeBudget()).toBeGreaterThanOrEqual(15);
  });

  it('job не обрывает шаг раньше самого curl', () => {
    // timeout-minutes меньше --max-time вернул бы обрыв, только этажом выше.
    const m = /timeout-minutes:\s*(\d+)/.exec(WF);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 60).toBeGreaterThan(clientPatience());
  });
});

describe('cron-evo: отказ называет себя', () => {
  it('код возврата curl перехватывается, а не убивает шаг молча', () => {
    // `bash -e` + `HTTP=$(curl ...)` без страховки = смерть до вывода.
    // Именно поэтому лог прогона 373 не содержал ничего, кроме кода выхода.
    expect(STEP).toMatch(/\|\|\s*CURL_RC=\$\?/);
    expect(STEP).toMatch(/if \[ "\$CURL_RC" != "0" \]/);
  });

  it('таймаут отделён от прочих отказов curl и назван причиной', () => {
    expect(STEP).toMatch(/"\$CURL_RC" = "28"/);
    expect(STEP).toMatch(/::error::/);
  });

  it('сообщение о таймауте указывает искать в стадиях прогона, а не в лимитах', () => {
    // Следующий читающий не должен снова поднимать --max-time: при запасе
    // это уже не про терпение вызывающего.
    const msg = /::error::Evo не ответил[^"]*/.exec(STEP);
    expect(msg, 'сообщение о таймауте исчезло').not.toBeNull();
    expect(msg![0]).toMatch(/agent_run_history|kernel_task_id/);
  });
});

describe('cron-evo: ack=1 здесь не применяется — и это защищено', () => {
  it('воркфлоу НЕ переключён на подтверждение приёма', () => {
    // ?ack=1 отдаёт 202 сразу и заведён под внешние планировщики, рвущие
    // связь за 30 секунд. Здесь он сделал бы крон ВЕЧНОЗЕЛЁНЫМ: воркфлоу
    // читает success/status из тела, а 202 их не несёт. Замена ложного
    // красного на ложный зелёный по §4.0 строго хуже — красное хотя бы
    // смотрят. Пока нет эндпоинта, читающего исход по kernel_task_id,
    // переключать сюда ack нельзя.
    expect(STEP, 'ack=1 в cron-evo.yml сделал бы прогон вечнозелёным').not.toMatch(/ack=1/);
  });

  it('исход по-прежнему берётся из ТЕЛА ответа, а не из HTTP-кода', () => {
    // HTTP 200 означает «частичные результаты доступны», а не «всё успешно».
    expect(STEP).toMatch(/\.success == true and \.status == "completed"/);
    expect(STEP).toMatch(/run_logged == false/);
  });
});
