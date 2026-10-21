/**
 * Один выход ответа Кузьмича — сами правила (аудит 15.10, пункт 1.14):
 * порядок сторожей, километраж против данных хода, блок 112 только когда его
 * ещё не отдали, поправки хвостом для уже показанного текста. Что каждая
 * поверхность этим выходом пользуется — kuzmich-guards-all-surfaces.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import {
  finishKuzmichAnswer, correctShownAnswer, groundingContext, SHOWN_BANNED_ADVICE_CORRECTION,
} from '@/lib/kuzmich/answer-guards';
import { DISTANCE_HONEST_LINE } from '@/lib/kuzmich/distance-guard';
import { DELIVERY_HONEST_LINE } from '@/lib/kuzmich/delivery-claim-guard';
import { recordSafetyReview } from '@/lib/kuzmich/safety-review-log';
import type { ToolRun } from '@/lib/agents/eval/grounding';

const KM = 'От Петропавловска до озера около 400 км.';
const LOST = 'Мы заблудились, что делать?';
const SOS_HEAD = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ:';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('finishKuzmichAnswer', () => {
  it('километраж без числа в данных вырезается и заменяется честной строкой', () => {
    const out = finishKuzmichAnswer({ surface: 'web', answer: `Озеро красивое. ${KM}`, question: 'Далеко?', toolRuns: [], context: '' });
    expect(out.text).not.toContain('400 км');
    expect(out.text).toContain(DISTANCE_HONEST_LINE);
    expect(out.text).toContain('Озеро красивое.');
    expect(out.distanceRemoved).toEqual([KM]);
  });

  it('то же число в контексте хода или в выводе инструмента с данными — опора есть, текст цел', () => {
    const inContext = finishKuzmichAnswer({ surface: 'web', answer: KM, question: 'Далеко?', toolRuns: [], context: 'Расстояние от Петропавловска: 400 км' });
    expect(inContext.text).toBe(KM);
    const runs: ToolRun[] = [{ name: 'get_place_info', producedData: true, output: 'до озера 400 км по трассе' }];
    expect(finishKuzmichAnswer({ surface: 'web', answer: KM, question: 'Далеко?', toolRuns: runs, context: '' }).text).toBe(KM);
  });

  it('инструмент, не принёсший данных, километраж не обосновывает', () => {
    const runs: ToolRun[] = [{ name: 'get_place_info', producedData: false, output: 'Места нет в справочнике. 400 км' }];
    expect(groundingContext(runs, '')).toBe('');
    expect(finishKuzmichAnswer({ surface: 'a2a', answer: KM, question: 'Далеко?', toolRuns: runs, context: '' }).text).toContain(DISTANCE_HONEST_LINE);
  });

  it('порядок: правки текста модели, потом блок 112 перед ним — сторожа блок 112 не судят', () => {
    const out = finishKuzmichAnswer({ surface: 'telegram', answer: `${KM} Заявка передана оператору.`, question: LOST, toolRuns: null, context: '' });
    expect(out.emergency).toBe(true);
    expect(out.text.startsWith(SOS_HEAD)).toBe(true);
    expect(out.text).toContain(DISTANCE_HONEST_LINE);
    expect(out.text).toContain(DELIVERY_HONEST_LINE);
  });

  it('sos: false — блок уже отдан (стрим): второго нет, правки — есть', () => {
    const out = finishKuzmichAnswer({ surface: 'web-stream', answer: KM, question: LOST, toolRuns: [], context: '', sos: false });
    expect(out.emergency).toBe(false);
    expect(out.text).not.toContain(SOS_HEAD);
    expect(out.text).toContain(DISTANCE_HONEST_LINE);
  });

  it('язык блока 112 — язык окна (виджет)', () => {
    const out = finishKuzmichAnswer({ surface: 'widget', answer: 'Stay together.', question: 'We are lost, help', toolRuns: [], context: '', lang: 'en' });
    expect(out.text.startsWith('IF THIS IS AN EMERGENCY:')).toBe(true);
  });

  it('журнал проверок безопасности получает имя поверхности', () => {
    finishKuzmichAnswer({ surface: 'widget', answer: 'Там безопасно.', question: 'Можно?', toolRuns: [], context: '' });
    expect(recordSafetyReview).toHaveBeenCalledWith('widget', expect.anything(), []);
  });
});

describe('correctShownAnswer — текст уже у человека', () => {
  it('нечего поправлять — хвоста нет', () => {
    expect(correctShownAnswer({ surface: 'web-stream', answer: 'Озеро красивое.', question: 'Как там?', toolRuns: null, context: '' }).tail).toBe('');
  });

  it('поправки идут хвостом в порядке сторожей: расстояние, опасный совет, доставка', () => {
    const shown = `${KM} Если выйдет медведь — притворись мёртвым. Заявка передана оператору.`;
    const { tail } = correctShownAnswer({ surface: 'web-stream', answer: shown, question: 'Как там?', toolRuns: null, context: '' });
    const at = (s: string) => tail.indexOf(s);
    expect(at(DISTANCE_HONEST_LINE)).toBeGreaterThan(-1);
    expect(at(SHOWN_BANNED_ADVICE_CORRECTION)).toBeGreaterThan(at(DISTANCE_HONEST_LINE));
    expect(at(DELIVERY_HONEST_LINE)).toBeGreaterThan(at(SHOWN_BANNED_ADVICE_CORRECTION));
    // Сказанное не повторяется в поправке.
    expect(tail).not.toContain('400 км');
  });

  it('поправка сторожа безопасности дописывается и после вырезанного совета', () => {
    const shown = 'Притворись мёртвым, если что. Сейчас там безопасно.';
    const plain = 'Сейчас там безопасно.';
    const withAdvice = correctShownAnswer({ surface: 'web-stream', answer: shown, question: 'Можно?', toolRuns: null, context: '' });
    const without = correctShownAnswer({ surface: 'web-stream', answer: plain, question: 'Можно?', toolRuns: null, context: '' });
    const safetyNote = without.tail.trim();
    expect(safetyNote.length).toBeGreaterThan(0);
    expect(withAdvice.tail).toContain(SHOWN_BANNED_ADVICE_CORRECTION);
    expect(withAdvice.tail).toContain(safetyNote);
  });
});
