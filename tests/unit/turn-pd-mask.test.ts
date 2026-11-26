/**
 * Имена людей не уходят в зарубежные модели (проверка безопасности ИИ-части
 * 26.11, слово владельца «чини Карт бланш»).
 *
 * До этого дня из реплики человека перед моделью вырезались только телефон и
 * почта. Заявка в чате — «Меня зовут Иван Петров, +7…, согласен» — оставалась
 * в истории и несла имя в модель на каждом следующем ходе; имя из текста
 * чужого агента по A2A уходило в Кузьмича, судью и переводчик журнала; имя
 * автора сообщения в Telegram-группе — в разбор группы.
 *
 * Здесь — вызовы: маска реплики (redactTurnPD), настоящий цикл Кузьмича с
 * подменённым провайдером, перевод журнала A2A и текст разбора группы. Судья —
 * tests/unit/kuzmich-judge-context.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { waterfall, quality } = vi.hoisted(() => ({ waterfall: vi.fn(), quality: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...orig,
    callToolsWaterfall: (...a: unknown[]) => waterfall(...a),
    callAIQualityOrNull: (...a: unknown[]) => quality(...a),
  };
});
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/FROM a2a_dialogs/.test(sql)) {
        return { rows: [{ id: 7, question: 'My name is John Smith, @jsmith, vk.com/id777 — is the Avachinsky trail open?', answer: 'Да, открыт.', question_ru: null, answer_ru: null }] };
      }
      return { rows: [] };
    }),
  },
}));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { redactTurnPD, redactUserTurns } from '@/lib/security/pii-redact';
import { aiChatAgentLoop } from '@/lib/kuzmich/core';
import { translateDialog } from '@/lib/a2a/dialog-translate';
import { groupPromptText } from '@/lib/telegram/group-monitor';

beforeEach(() => {
  waterfall.mockReset();
  waterfall.mockResolvedValue({ content: 'Ответ.', provider: 'test' });
  quality.mockReset();
  quality.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тесте закрыта')));
});
afterEach(() => vi.unstubAllGlobals());

describe('маска реплики человека', () => {
  it('явное имя, ник, профиль соцсети, телефон и почта скрыты', () => {
    const out = redactTurnPD('Меня зовут Иван Петров, +7 914 123-45-67, ivan@mail.ru, @ivanp, vk.com/id12345. Имя: Анна. С уважением, Мария');
    for (const leak of ['Иван', 'Петров', '914', 'ivan@mail.ru', '@ivanp', 'id12345', 'Анна', 'Мария']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain('[имя]');
  });

  // Ревью безопасности PR #3840: регистр, двоеточие и лишние пробелы.
  it('имя скрыто в любом регистре, после двоеточия и через два пробела', () => {
    const cases: Array<[string, string[]]> = [
      ['меня зовут иван петров, я потерялся', ['иван', 'петров']],
      ['МЕНЯ ЗОВУТ ИВАН ПЕТРОВ', ['ИВАН', 'ПЕТРОВ']],
      ['Меня зовут: Иван Петров, я потерялся в районе Мутновского', ['Иван', 'Петров']],
      ['Меня зовут Иван  Петров', ['Иван', 'Петров']],
      ['Меня зовут Иван\tПетрович Сидоров', ['Иван', 'Петрович', 'Сидоров']],
      ['My name is: John Smith', ['John', 'Smith']],
      ['my name is john', ['john']],
      ['Нас зовут Анна, едем вдвоём', ['Анна']],
      ['Имя:  Мария', ['Мария']],
      ["Hi, I'm John. Is the trail open?", ['John']],
    ];
    for (const [text, leaks] of cases) {
      const out = redactTurnPD(text);
      for (const leak of leaks) expect(out, `${text} → ${out}`).not.toMatch(new RegExp(`(^|[^\\p{L}])${leak}(?![\\p{L}])`, 'u'));
      expect(out, text).toContain('[имя]');
    }
  });

  it('строчное имя не съедает фразу: вулкан после имени остаётся', () => {
    expect(redactTurnPD('меня зовут иван и я хочу на Мутновский')).toBe('меня зовут [имя] и я хочу на Мутновский');
    expect(redactTurnPD("I'm at the crater, is it safe?")).toBe("I'm at the crater, is it safe?");
  });

  it('место в разговоре о поле и свои ссылки остаются', () => {
    const text = 'Мы на вулкане. Это Горелый. Я на тропе у Авачинского, вот тур https://vedarai.ru/catalog/tours/12';
    expect(redactTurnPD(text)).toBe(text);
  });

  it('redactUserTurns чистит реплики человека этой маской, остальные роли — как есть', () => {
    const out = redactUserTurns([
      { role: 'user', content: 'Меня зовут Иван Петров' },
      { role: 'assistant', content: 'Иван, здравствуйте' },
    ]);
    expect(out[0].content).toBe('Меня зовут [имя]');
    expect(out[1].content).toBe('Иван, здравствуйте');
  });
});

describe('цикл Кузьмича: имя не доходит до модели', () => {
  it('ни из вопроса, ни из истории (реплика заявки)', async () => {
    await aiChatAgentLoop(
      'Меня зовут Пётр Сидоров, когда лучше ехать на Мутновский?',
      'система',
      [{ role: 'user', content: 'Имя: Анна Козлова, +79141234567, согласна' }, { role: 'assistant', content: 'Записал.' }],
      [],
    );
    const sent = JSON.stringify(waterfall.mock.calls[0]![0]);
    for (const leak of ['Пётр', 'Сидоров', 'Анна', 'Козлова', '9141234567']) expect(sent, leak).not.toContain(leak);
    expect(sent).toContain('Мутновский');
  });
});

describe('перевод журнала A2A — с маской переписки', () => {
  it('имя, ник и профиль в тексте агента до модели перевода не доходят', async () => {
    await translateDialog(7);
    expect(quality).toHaveBeenCalled();
    const sent = JSON.stringify(quality.mock.calls[0]![0]);
    for (const leak of ['John', 'Smith', '@jsmith', 'id777']) expect(sent, leak).not.toContain(leak);
    expect(sent).toContain('Avachinsky');
  });
});

describe('разбор Telegram-группы — авторы псевдонимами', () => {
  it('имя автора заменено «Участник N» по первому появлению, телефон в тексте скрыт', () => {
    const out = groupPromptText([
      { from: 'Ярослав', text: 'Сегодня на перевале снег, звоните +7 914 000-11-22' },
      { from: 'Ольга', text: 'Подтверждаю, дорога закрыта' },
      { from: 'Ярослав', text: 'Медведь у Вилючинского' },
    ]);
    expect(out).not.toMatch(/Ярослав|Ольга|914/);
    expect(out.split('\n')).toEqual([
      expect.stringMatching(/^\[Участник 1\]: Сегодня на перевале снег/),
      expect.stringMatching(/^\[Участник 2\]: Подтверждаю/),
      expect.stringMatching(/^\[Участник 1\]: Медведь у Вилючинского/),
    ]);
  });
});
