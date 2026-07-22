/**
 * Мост Разведка → Эволюция: чистый разбор предложений модели.
 * Терпим к обёртке, строг к пустышкам — иначе в бэклог полезет мусор.
 */
import { describe, it, expect } from 'vitest';
import { parseIntelProposals } from '@/lib/agents/evo/intel-bridge';

describe('parseIntelProposals', () => {
  it('чистый JSON-массив с валидными предложениями', () => {
    const raw = JSON.stringify([
      { title: 'Офлайн-карта через MCP', description: 'Вышел новый MCP-сервер для офлайн-тайлов — релевантно офлайн-карте.', suggestion: 'Оценить интеграцию в offline-precache.' },
      { title: 'Стандарт МЧС по регистрации', description: 'Камгов сообщил об обновлении формы регистрации групп.', suggestion: 'Свериться с нашим МЧС-помощником.' },
    ]);
    const out = parseIntelProposals(raw);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Офлайн-карта через MCP');
  });

  it('снимает ```json-обёртку и текст вокруг массива', () => {
    const raw = 'Вот результат:\n```json\n[{"title":"Тест интеграции","description":"описание","suggestion":"сделать"}]\n```\nвсё.';
    expect(parseIntelProposals(raw)).toHaveLength(1);
  });

  it('пустой массив (нечего внедрять) → []', () => {
    expect(parseIntelProposals('[]')).toEqual([]);
    expect(parseIntelProposals('Ничего применимого нет.')).toEqual([]);
  });

  it('отбрасывает элементы без description/suggestion или с пустым/длинным title', () => {
    const raw = JSON.stringify([
      { title: 'Ок', description: '', suggestion: 'x' },              // пустой description
      { title: 'a', description: 'd', suggestion: 's' },              // слишком короткий title
      { title: 'x'.repeat(200), description: 'd', suggestion: 's' },  // слишком длинный title
      { title: 'Нет значимых сигналов', description: 'd', suggestion: 's' }, // мусор-заголовок
      { title: 'Валидное предложение', description: 'd', suggestion: 's' },  // ← единственное валидное
    ]);
    const out = parseIntelProposals(raw);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Валидное предложение');
  });

  it('невалидный JSON / null → []', () => {
    expect(parseIntelProposals('не JSON вовсе')).toEqual([]);
    expect(parseIntelProposals(null)).toEqual([]);
    expect(parseIntelProposals('{"title":"объект, не массив"}')).toEqual([]);
  });
});
