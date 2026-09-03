/**
 * Сторож: пустой цикл разведки называет причину.
 *
 * Watchdog 23.08.2026: «Intelligence Monitor — 4 прогонов подряд без
 * результата, ПРИЧИНА ПРОПУСКА НЕ ЗАПИСАНА». Тревога была права дважды.
 *
 * Причины не было в цикле: `Promise.allSettled` отбрасывал отклонённые домены
 * молча (`if (result.status === 'fulfilled' && result.value)`), а роут писал в
 * историю жёсткий `errors_count: 0`. Цикл, у которого упали ВСЕ домены,
 * выглядел ровно как цикл, честно не нашедший ничего применимого.
 *
 * И причины не было ГДЕ ИСКАТЬ: Watchdog спрашивал `metadata->>'digest_skip_
 * reason'` — ключ, заведённый для разведчика. Любой другой крон в эту графу не
 * попадал по построению, сколько бы он ни писал.
 *
 * Различать исходы важно не ради полноты: «модель промолчала» — это провайдер,
 * а «ничего применимого» — правильный ответ, которого промпт прямо и просит
 * («сказать об этом — правильный ответ, а не провал задачи»). Чинятся они в
 * разных местах, и ровнять их одной меткой значит либо гоняться за призраком,
 * либо пролистывать настоящий отказ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const SERVICE = strip(read('lib/services/intelligence-monitor.service.ts'));
const ROUTE = strip(read('app/api/cron/intelligence/route.ts'));
const WATCHDOG = strip(read('lib/agents/watchdog.ts'));

describe('исходы домена различимы', () => {
  it('немота модели и «не применимо» — разные исходы', () => {
    expect(SERVICE).toMatch(/outcome: 'model_mute'/);
    expect(SERVICE).toMatch(/outcome: 'nothing_relevant'/);
  });

  it('разбор домена больше не возвращает голый null', () => {
    // `null` не отвечал на вопрос «почему»: он одинаков для упавшего
    // провайдера, битого JSON и честного «ничего интересного».
    const analyze = SERVICE.slice(SERVICE.indexOf('async function analyzeSignals'));
    expect(analyze.slice(0, analyze.indexOf('\n}'))).not.toMatch(/return null;/);
  });

  it('отклонённый домен считается, а не тонет', () => {
    expect(SERVICE).toMatch(/result\.status === 'rejected'/);
    expect(SERVICE).toMatch(/outcomes\.gather_failed\+\+/);
  });
});

describe('пустой цикл называет ленту поимённо, а не только классом (03.09)', () => {
  /**
   * Перепись админ-панели 03.09: «Разведка» четвёртые сутки числилась
   * пустой. Сервис уже собирал `empty_reasons` — домен и имя ленты с
   * текстом отказа, — а роут крона это ОТБРАСЫВАЛ: в историю и в ответ
   * доезжал только `skip_reason: no_signals`. Из лога GitHub Actions
   * (единственное место, видное без админ-доступа) выходило
   * `raw_signals: 72, findings: 0, domains: []` — читается как «мертва»,
   * тогда как 72 сигнала дошли и модель честно сказала «не применимо».
   */
  it('роут пишет empty_reasons в историю прогонов', () => {
    const meta = ROUTE.slice(ROUTE.indexOf('metadata: {'), ROUTE.indexOf('// Log to audit trail'));
    expect(meta).toMatch(/empty_reasons: report\.empty_reasons/);
  });

  it('роут отдаёт причину и имена лент в ответе — их читают из лога Actions', () => {
    const resp = ROUTE.slice(ROUTE.indexOf('return NextResponse.json({'));
    expect(resp).toMatch(/skip_reason: report\.skip_reason/);
    expect(resp).toMatch(/empty_reasons: report\.empty_reasons/);
    expect(resp).toMatch(/outcomes: report\.outcomes/);
  });
});

describe('причина выбирается по чинимости, а не по частоте', () => {
  it('отказы идут раньше честного «не применимо»', () => {
    // Иначе один относящийся к делу отказ спрячется за пятью законными
    // «не применимо», и разбор начнётся не с того конца.
    const chain = SERVICE.slice(SERVICE.indexOf('const skipReason'));
    const order = ['gather_failed', 'model_mute', 'model_malformed', 'no_signals', 'nothing_relevant']
      .map((k) => chain.indexOf(k));
    expect(order.every((v, i) => i === 0 || v > order[i - 1]), `порядок причин: ${order}`).toBe(true);
  });

  it('есть находки — причины нет, а не «не применимо» для вида', () => {
    expect(SERVICE).toMatch(/findings\.length > 0 \? null/);
  });
});

describe('причина доезжает до истории прогонов', () => {
  it('роут пишет skip_reason и настоящий счёт отказов', () => {
    expect(ROUTE).toMatch(/skip_reason: report\.skip_reason/);
    expect(ROUTE, 'вернулся жёсткий ноль ошибок').not.toMatch(/errors_count: 0/);
    expect(ROUTE).toMatch(/errors_count: report\.errors_count/);
  });
});

describe('Watchdog спрашивает причину у ЛЮБОГО крона', () => {
  it('ключ общий, а не заведённый под разведчика', () => {
    expect(WATCHDOG).toMatch(/COALESCE\(metadata->>'skip_reason', metadata->>'digest_skip_reason'\)/);
  });

  it('исторический ключ разведчика не потерян', () => {
    // В уже записанных прогонах лежит он; выкинуть значит ослепить тревогу
    // на всю прошлую историю.
    expect(WATCHDOG).toMatch(/digest_skip_reason/);
  });
});
