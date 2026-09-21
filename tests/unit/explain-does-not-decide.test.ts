/**
 * Объяснение пересказывает решение и не может его изменить.
 *
 * ── Зачем этот механизм вообще (21.09) ────────────────────────────────────
 *
 * Владелец спросил, нельзя ли сделать так, чтобы проект сам был ИИ и любое
 * действие на проде было живым промптом. В чистом виде нельзя: полевой контур
 * обязан работать без связи, а деньги и безопасность не терпят
 * недетерминированности. Но есть сторона, где модель уместна: не РЕШАТЬ, а
 * объяснять уже принятое решение.
 *
 * Первая такая поверхность — вердикт о ведении по линии. Человек на экране
 * выбора читает «Точка стоит в 7.9 км от линии — данные маршрута не
 * сходятся»: формулировка верная, а что с ней делать, непонятно.
 *
 * ── Почему сторож именно такой ────────────────────────────────────────────
 *
 * Весь замысел держится на одном: решает код, пересказывает модель, проверяет
 * снова код. Стоит пересказу получить власть над вердиктом — и платформа
 * начнёт обещать ведение словами модели, а не по данным. Поэтому первая
 * группа случаев проверяет ровно это, причём при ЛЮБОМ ответе модели,
 * включая прямо противоположный.
 *
 * Вторая группа — проверка пересказа. Выдумку как таковую не поймать (это уже
 * записано в `desc-facts`); ловится противоречие тому, что платформа знает
 * сама, и здесь знание полное: всё, что пересказ вправе назвать, лежит в
 * протоколе решения.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const callAIFastOrNullMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFastOrNull: (...a: unknown[]) => callAIFastOrNullMock(...a),
}));

import {
  explainNavigability, navigabilityRecord, resetExplanationCache,
} from '@/lib/explain/navigability-explainer';
import { checkExplanation } from '@/lib/explain/no-invention';
import { decisionFingerprint, recordNumbers } from '@/lib/explain/decision-record';
import type { Navigability } from '@/lib/routes/navigability';

const REFUSED: Navigability = {
  verdict: 'orientation_only',
  canLead: false,
  reasons: ['Точка стоит в 7.9 км от линии — данные маршрута не сходятся'],
  conflict: { index: 1, offTrackKm: 7.9 },
};
const NAMES = ['Старт', 'Ключевские источники'];

beforeEach(() => {
  resetExplanationCache();
  callAIFastOrNullMock.mockReset();
});

describe('вердикт остаётся вердиктом кода', () => {
  it('модель сказала обратное — решение не сдвинулось', () => {
    // Самый опасный случай: пересказ утверждает, что идти можно.
    callAIFastOrNullMock.mockResolvedValue('Маршрут отличный, ведение по линии обещано, идите смело.');
    return explainNavigability(REFUSED, NAMES).then((r) => {
      expect(r.verdict).toBe('orientation_only');
      expect(r.canLead).toBe(false);
      expect(r.reasons).toEqual(REFUSED.reasons);
    });
  });

  it('модель молчит — решение и причины на месте', async () => {
    callAIFastOrNullMock.mockResolvedValue(null);
    const r = await explainNavigability(REFUSED, NAMES);
    expect(r.state).toBe('unavailable');
    expect(r.text).toBeNull();
    expect(r.canLead).toBe(false);
    expect(r.reasons).toEqual(REFUSED.reasons);
  });

  it('пересказ не проходит проверку — человек остаётся с сухими причинами', async () => {
    callAIFastOrNullMock.mockResolvedValue('Точка стоит в 42 км от линии, это далеко от тропы.');
    const r = await explainNavigability(REFUSED, NAMES);
    expect(r.state).toBe('rejected');
    expect(r.text).toBeNull();
    expect(r.why).toContain('42');
    expect(r.reasons).toEqual(REFUSED.reasons);
  });

  it('годный пересказ показывается, вердикт при этом тот же', async () => {
    callAIFastOrNullMock.mockResolvedValue(
      'Одна из точек маршрута стоит в 7.9 км от линии, поэтому вести по ней платформа не берётся.',
    );
    const r = await explainNavigability(REFUSED, NAMES);
    expect(r.state).toBe('accepted');
    expect(r.text).toContain('7.9');
    expect(r.canLead).toBe(false);
  });
});

describe('за один и тот же вердикт платим один раз', () => {
  it('повтор берётся из памяти, модель не зовётся', async () => {
    callAIFastOrNullMock.mockResolvedValue('Точка стоит в 7.9 км от линии — вести по ней не берёмся.');
    await explainNavigability(REFUSED, NAMES);
    const again = await explainNavigability(REFUSED, NAMES);
    expect(again.state).toBe('cached');
    expect(callAIFastOrNullMock).toHaveBeenCalledTimes(1);
  });

  it('другой вердикт — другой отпечаток, значит свой вызов', () => {
    const a = decisionFingerprint(navigabilityRecord(REFUSED, NAMES));
    const b = decisionFingerprint(navigabilityRecord(
      { verdict: 'navigable', canLead: true, reasons: [] }, NAMES,
    ));
    expect(a).not.toBe(b);
  });
});

describe('протокол несёт то, на что пересказ вправе опираться', () => {
  it('причины переносятся дословно', () => {
    expect(navigabilityRecord(REFUSED, NAMES).reasons).toEqual(REFUSED.reasons);
  });

  it('спорная точка названа по имени — черта знает только номер', () => {
    const rec = navigabilityRecord(REFUSED, NAMES);
    expect(rec.facts.find(f => f.key === 'conflict_place')?.value).toBe('Ключевские источники');
    expect(rec.facts.find(f => f.key === 'off_track_km')?.value).toBe('7.9');
  });

  it('имени нет — факта нет, выдуманного имени тоже', () => {
    const rec = navigabilityRecord(REFUSED, ['Старт', null]);
    expect(rec.facts.some(f => f.key === 'conflict_place')).toBe(false);
  });

  it('числа протокола собраны из причин и фактов', () => {
    expect(recordNumbers(navigabilityRecord(REFUSED, NAMES)).has('7.9')).toBe(true);
  });
});

describe('пересказ проверяется, а не принимается на слово', () => {
  const rec = navigabilityRecord(REFUSED, NAMES);
  const ok = 'Точка маршрута стоит в 7.9 км от линии, поэтому ведение по ней не обещано.';

  it('число не из протокола — отказ', () => {
    expect(checkExplanation('Линия отклоняется на 12 км, идти можно осторожно.', rec).state).toBe('rejected');
  });

  it('округление — тоже отказ: это редактура факта', () => {
    expect(checkExplanation('Точка стоит примерно в 8 км от линии.', rec).state).toBe('rejected');
  });

  it('число из протокола с запятой — принимается', () => {
    expect(checkExplanation('Точка стоит в 7,9 км от линии, вести по ней не берёмся.', rec).state).toBe('accepted');
  });

  it('совет сойти с тропы — отказ', () => {
    const r = checkExplanation('Сойдите с тропы и обойдите точку стороной, там интереснее.', rec);
    expect(r.state).toBe('rejected');
  });

  it('обещание трека там, где вести нельзя, — отказ', () => {
    expect(checkExplanation('Скачайте GPS-трек и идите по нему уверенно.', rec).state).toBe('rejected');
  });

  it('эмодзи — отказ: правило проекта одно на весь текст', () => {
    expect(checkExplanation(`${ok} \u{1F3D4}`, rec).state).toBe('rejected');
  });

  it('обрывок и простыня — отказ', () => {
    expect(checkExplanation('Нет.', rec).state).toBe('rejected');
    expect(checkExplanation(`${ok} `.repeat(20), rec).state).toBe('rejected');
  });

  it('модель не ответила — это НЕ то же, что соврала', () => {
    // Оба исхода возвращают человека к сухим причинам, но в журнале это
    // разные строки: «нет связи» и «нельзя верить» лечатся по-разному.
    expect(checkExplanation(null, rec).state).toBe('unavailable');
    expect(checkExplanation('Отклонение 99 км.', rec).state).toBe('rejected');
  });

  it('у пригодного маршрута обещание трека законно', () => {
    const good = navigabilityRecord({ verdict: 'navigable', canLead: true, reasons: [] }, []);
    expect(checkExplanation('Линия снята прибором, можно идти по треку без опасений.', good).state)
      .toBe('accepted');
  });
});

describe('подключение: за пересказ платят по нажатию', () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), 'utf-8');
  const ROUTE = read('app/api/routes/[id]/route.ts');
  const CLIENT = read('app/planning/_PlanningClient.tsx');
  const code = (src: string) =>
    src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('объяснение спрашивается явно, а не при каждом открытии карточки', () => {
    // Вызов модели на каждое открытие — это счёт за то, о чём не просили.
    expect(code(ROUTE)).toMatch(/if \(wantExplain\)/);
    expect(code(ROUTE)).toMatch(/explain.*===\s*'1'/);
  });

  it('параметр проверяется схемой, а не читается как есть', () => {
    expect(code(ROUTE)).toMatch(/z\.object\(\{\s*explain/);
  });

  it('пересказ едет ОТДЕЛЬНЫМ полем — вердикт остаётся вердиктом', () => {
    expect(code(ROUTE)).toContain('navigability: cardNavigability,');
    expect(code(ROUTE)).toContain('navigabilityExplanation: explanation,');
  });

  it('экран берёт только текст, решение читает из вердикта', () => {
    expect(code(CLIENT)).toMatch(/navigabilityExplanation/);
    // Право вести экран по-прежнему узнаёт у черты, а не из пересказа.
    expect(code(CLIENT)).toMatch(/preview\.navigability\.reasons/);
  });

  it('нет пересказа — экран говорит об этом, а не молчит', () => {
    expect(CLIENT).toContain('Объяснить сейчас не вышло');
  });
});
