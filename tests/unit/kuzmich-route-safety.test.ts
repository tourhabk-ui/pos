/**
 * Строка безопасности под ответом о маршруте (lib/kuzmich/route-safety):
 * дописывается к маршруту без 112, называет предупреждение МЧС только из
 * живого блока, молчит об обстановке без данных и не дублирует SOS.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import {
  appendRouteSafety, isRouteQuestion, ROUTE_SAFETY_LINE, ROUTE_112_LINE,
} from '@/lib/kuzmich/route-safety';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import { formatWarningBlock, warningsFromRows, MCHS_UNREAD_NOTE } from '@/lib/safety/mchs-bulletin';

const BLOCK = formatWarningBlock(warningsFromRows([
  { alert_type: 'volcanic_eruption', title: 'Вулкан Шивелуч: выброс пепла', description: '', volcano_name: 'Шивелуч', source_url: 'https://41.mchs.gov.ru/x' },
]));

describe('isRouteQuestion', () => {
  it.each([
    'Расскажи про маршрут на Авачинский вулкан.',
    'Как добраться до Долины гейзеров?',
    'Хотим сами сходить в поход в Налычево',
  ])('маршрут: %s', (q) => expect(isRouteQuestion(q)).toBe(true));

  it.each([
    'Какие туры есть на Толбачик?',
    'Сколько стоит восхождение на Авачинский?',
    'Когда сезон рыбалки на горбушу?',
  ])('не маршрут: %s', (q) => expect(isRouteQuestion(q)).toBe(false));
});

describe('appendRouteSafety', () => {
  const Q = 'Расскажи про маршрут на вулкан Шивелуч';

  it('ответ без 112 — строка с регистрацией в МЧС и 112', () => {
    const out = appendRouteSafety('Маршрут длинный.', 'Расскажи про маршрут на Авачинский вулкан', '');
    expect(out).toBe(`Маршрут длинный.\n\n${ROUTE_SAFETY_LINE}`);
  });

  it('регистрацию модель назвала — дописывается только 112', () => {
    const out = appendRouteSafety('Группу регистрируйте в МЧС заранее.', 'Маршрут на Авачинский?', '');
    expect(out.endsWith(ROUTE_112_LINE)).toBe(true);
    expect(out).not.toContain(ROUTE_SAFETY_LINE);
  });

  it('112 в ответе есть — ответ не трогается', () => {
    expect(appendRouteSafety('В беде — 112.', 'Маршрут на Авачинский?', '')).toBe('В беде — 112.');
  });

  it('предупреждение о месте из вопроса берётся из живого блока', () => {
    const out = appendRouteSafety('Красивый маршрут.', Q, BLOCK);
    expect(out).toContain('МЧС: к вулкану Шивелуч рекомендовано не приближаться');
    expect(out).toContain('https://41.mchs.gov.ru/x');
  });

  it('блока нет или сводка не прочитана — об обстановке ни слова', () => {
    for (const ctx of ['', MCHS_UNREAD_NOTE]) {
      const out = appendRouteSafety('Красивый маршрут.', Q, ctx);
      expect(out).toBe(`Красивый маршрут.\n\n${ROUTE_SAFETY_LINE}`);
      expect(out).not.toMatch(/спокойн|тревог нет|уровень/i);
    }
  });

  it('ЧП в вопросе — строку не ставим, 112 даёт SOS-блок', () => {
    const q = 'Мы заблудились на маршруте у вулкана, что делать?';
    expect(appendRouteSafety('Оставайтесь на месте.', q, '')).toBe('Оставайтесь на месте.');
    const fin = finishKuzmichAnswer({ surface: 'web', answer: 'Оставайтесь на месте.', question: q, toolRuns: [], context: '' });
    expect(fin.text).not.toContain(ROUTE_SAFETY_LINE);
    expect(fin.text.match(/112/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('вопрос не о маршруте — ответ не трогается', () => {
    expect(appendRouteSafety('Сезон в июле.', 'Когда сезон горбуши?', '')).toBe('Сезон в июле.');
  });
});

describe('finishKuzmichAnswer', () => {
  it('ответ о маршруте на сайте получает строку безопасности', () => {
    const fin = finishKuzmichAnswer({ surface: 'web', answer: 'Подъём занимает день.', question: 'Расскажи про маршрут на Авачинский вулкан', toolRuns: [], context: '' });
    expect(fin.text).toContain(ROUTE_SAFETY_LINE);
  });

  it('виджет на английском — русскую строку не ставим', () => {
    const fin = finishKuzmichAnswer({ surface: 'widget', answer: 'One day hike.', question: 'Tell me about the Avachinsky volcano route', toolRuns: [], context: '', lang: 'en' });
    expect(fin.text).toBe('One day hike.');
  });
});

describe('isRouteQuestion — места и звери', () => {
  it('ловит вопрос про медведей у Курильского озера', async () => {
    const { isRouteQuestion } = await import('@/lib/kuzmich/route-safety');
    expect(isRouteQuestion('Опасно ли из-за медведей у Курильского озера?')).toBe(true);
    expect(isRouteQuestion('Сколько стоит тур на Курильское озеро?')).toBe(false);
  });
});
