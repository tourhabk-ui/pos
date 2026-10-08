/**
 * Сторож фильтра `get_tours` (сверка MCP 25.09): «вулканы» — не тип тура, и
 * ответ «по типу нет» плюс полный каталог рыбалки читался как подмена.
 */
import { describe, it, expect } from 'vitest';
import { filterTourCatalog } from '@/lib/kuzmich/tour-filter';
import { activityLabel } from '@/lib/tours/labels';

const LABEL = (s: string) => ({ fishing: 'Рыбалка', rafting: 'Сплав' } as Record<string, string>)[s] ?? s;
const CTX = [
  'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:',
  'ID1: "Рыбалка на Большой" тип:fishing 3 дн. от 45 000 р/чел',
  'ID2: "Сплав по Быстрой" тип:rafting 1 дн. от 12 000 р/чел — с видом на вулканы Авачинской группы',
].join('\n');

describe('get_tours: слово туриста', () => {
  it('тип находится по русской метке', () => {
    const out = filterTourCatalog(CTX, 'рыбалка', LABEL);
    expect(out).toContain('ID1');
    expect(out).not.toContain('ID2');
  });

  it('не тип, но упомянуто в описании — показано с пометкой «тип другой»', () => {
    const out = filterTourCatalog(CTX, 'вулканы', LABEL);
    expect(out).toMatch(/^Тура с типом «вулканы» нет/);
    expect(out).toContain('ID2');
    expect(out).not.toContain('ID1');
  });

  it('нигде нет — сказано прямо, каталог только как замена с оговоркой', () => {
    const out = filterTourCatalog(CTX, 'гейзеры', LABEL);
    expect(out).toMatch(/^Туров «гейзеры» у операторов платформы сейчас нет/);
    expect(out).toContain('Не выдавай другие туры за такие');
  });
});

// 08.10: тип сравнивался подписью целиком, и «вулканы» не находили volcano
// («Восхождение на вулкан»), а сам тур уходил в «тип у них другой».
describe('get_tours: тип — по основе слова, во всех регистрах подписи', () => {
  // Настоящий словарь платформы, а не заглушка: ошибка была в его подписи.
  const REAL = activityLabel;
  const KRAI = [
    'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ (актуальные цены, называй по имени):',
    'ID41: "Вулкан Плоский Толбачик" — Вулкан Плоский Толбачик  тип:trekking 4 дн. от 60 000 ₽/чел.',
    'ID45: "Экскурсия в Долину гейзеров и кальдеру вулкана Узон" — Долина гейзеров  тип:helicopter  от 97 000 ₽/чел.',
    'ID46: "Восхождение на вулкан Ключевская Сопка" — Вулкан Ключевская Сопка  тип:volcano 12 дн. от 320 000 ₽/чел.',
    'ID47: "Автомобильный тур на Курильское озеро" — Курильское озеро  тип:bears 7 дн. от 150 000 ₽/чел.',
    'ID27: "Сплав по реке Быстрая" — Река Быстрая  тип:rafting  от 13 000 ₽/чел.',
    '',
    'Когда турист спрашивает о конкретном туре — дай факты.',
  ].join('\n');

  it('«вулканы» находят тип volcano; упоминания при другом типе — следом, с оговоркой', () => {
    const out = filterTourCatalog(KRAI, 'вулканы', REAL);
    expect(out).not.toMatch(/Тура с типом «вулканы» нет/);
    const [typed, rest] = out.split(/Ещё упоминают «вулканы»/);
    expect(typed).toContain('ID46');
    expect(typed).not.toContain('ID41');
    expect(rest).toContain('ID41');
    expect(rest).toContain('ID45');
    expect(rest).not.toContain('ID47');
    expect(rest).not.toContain('ID27');
    // Шапка и подсказка каталога на месте.
    expect(out.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
    expect(out).toContain('Когда турист спрашивает о конкретном туре');
  });

  it.each([
    ['вулкан', 'ID46'], ['volcano', 'ID46'], ['восхождение', 'ID46'],
    ['медведи', 'ID47'], ['сплав', 'ID27'], ['вертолёт', 'ID45'], ['вертолет', 'ID45'],
    ['трекинг', 'ID41'], ['треккинг', 'ID41'],
  ])('«%s» → %s по типу', (word, id) => {
    const out = filterTourCatalog(KRAI, word, REAL);
    // Ветка «совпал тип», а не «туров нет» с приложенным каталогом: в том
    // каталоге нужный ID тоже есть, и проверка «содержит» его не отличила бы.
    expect(out.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
    const typed = out.split(/Ещё упоминают/)[0];
    expect(typed.match(/^ID\d+/gm)).toEqual([id]);
  });

  it('просьба из нескольких слов — каждое у одного типа', () => {
    // «наблюдение» есть в подписи медведей, «китами» — нет: это не медведи.
    const out = filterTourCatalog(KRAI, 'наблюдение за китами', REAL);
    expect(out).not.toMatch(/^РЕАЛЬНЫЕ ТУРЫ[\s\S]*ID47/);
  });

  it('слово подписи короче четырёх букв не ловит всё подряд', () => {
    const out = filterTourCatalog(KRAI, 'туры', REAL);
    expect(out).toMatch(/^Туров «туры»/);
  });
});
