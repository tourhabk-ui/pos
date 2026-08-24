/**
 * safeJSON (lib/services/operators/lead-processor.service.ts) — разбор
 * JSON-ответа ИИ в пайплайне лида (квалификация, bull, bear, arbiter,
 * генерация предложения).
 *
 * До 24.08 неудачный парсинг возвращал заглушку молча. Заглушка от настоящего
 * результата снаружи неотличима: score, вердикт и текст предложения выглядят
 * как обычные, посчитанные. Хуже всего — при отказе ВСЕХ ИИ-провайдеров
 * callAIFast не бросает исключение, а возвращает строку AI_FAST_UNAVAILABLE
 * ('Сервис временно недоступен.'), которая не парсится как JSON и молча
 * попадает сюда же: во время простоя ИИ КАЖДЫЙ обрабатываемый лид тихо
 * получал заниженный score, и ничто не связывало это с простоем (§4.0).
 */
import { describe, it, expect, vi } from 'vitest';
import { safeJSON } from '@/lib/services/operators/lead-processor.service';

describe('safeJSON: успешный разбор не шумит', () => {
  it('валидный JSON — возвращается как есть, лог молчит', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = safeJSON('{"signals":["сильный сигнал"]}', { signals: [] }, 'bull');
    expect(result).toEqual({ signals: ['сильный сигнал'] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('JSON в markdown-ограждении разбирается', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = safeJSON('```json\n{"risks":["риск"]}\n```', { risks: [] }, 'bear');
    expect(result).toEqual({ risks: ['риск'] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('safeJSON: заглушка отдаётся, но отказ называется', () => {
  it('битый JSON — заглушка возвращается (контракт не изменился)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallback = { signals: [] as string[] };
    const result = safeJSON('это не JSON вовсе', fallback, 'bull');
    expect(result).toBe(fallback);
    spy.mockRestore();
  });

  it('битый JSON пишет в лог метку вызова и фрагмент ответа', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeJSON('это не JSON вовсе', { signals: [] }, 'bull');

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0].join(' ');
    expect(logged).toMatch(/bull/);
    expect(logged).toMatch(/это не JSON вовсе/);
    spy.mockRestore();
  });

  it('AI_FAST_UNAVAILABLE (отказ ВСЕХ провайдеров) — тот самый случай, который раньше терялся', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Ровно то, что возвращает callAIFast(), когда ни один провайдер не ответил —
    // lib/ai/providers.ts: export const AI_FAST_UNAVAILABLE = 'Сервис временно недоступен.'
    const result = safeJSON('Сервис временно недоступен.', { conversion_prob: 50 }, 'arbiter');

    expect(result).toEqual({ conversion_prob: 50 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].join(' ')).toMatch(/arbiter.*Сервис временно недоступен/s);
    spy.mockRestore();
  });

  it('каждый вызывающий узнаётся по своей метке — arbiter и proposal не путаются в логе', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeJSON('плохой json', {}, 'arbiter');
    safeJSON('плохой json', {}, 'proposal');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0].join(' ')).toMatch(/arbiter/);
    expect(spy.mock.calls[1].join(' ')).toMatch(/proposal/);
    spy.mockRestore();
  });
});
