/**
 * Тест планировщика владельца 21.11, п. 1: карточки под ответом — ровно туры
 * из текста плана, и в тексте они — ссылки на свои страницы.
 */
import { describe, it, expect } from 'vitest';
import { toursNamedInAnswer, linkNamedTours, NAMED_TOUR_CARDS_MAX } from '@/lib/kuzmich/answer-tour-cards';
import { parseTourLines } from '@/lib/agents/eval/commercial-checks';

// Срез витрины в формате get_tours (ID…: "название" …).
const CATALOG = [
  'ID70: "Восхождение на вулкан Горелый и лавовые пещеры" — Горелый тип:volcano 1 день от 15 000 ₽/чел. | Оп: Андрей Запорожец',
  'ID64: "Бухта Русская (морская прогулка)" тип:sea 1 день от 20 000 ₽/чел. | Оп: Местечко Камчатка',
  'ID119: "Вулканы Камчатки (5 дней)" тип:volcano 5 дней от 60 000 ₽/чел. | Оп: Лагуна Экспедиция',
  'ID98: "Облёт вулканов Мутновский и Горелый + Ходуткинские горячие источники" тип:helicopter от 55 000 ₽/чел. | Оп: Лагуна Экспедиция',
  'ID110: "Облёт Авачинской бухты и Авачинского вулкана + Тимоновские источники" тип:helicopter от 60 000 ₽/чел. | Оп: Лагуна Экспедиция',
  'ID5: "Морская рыбалка" тип:fishing от 15 000 ₽/чел. | Оп: Кто-то',
].join('\n');
const UNIVERSE = parseTourLines(CATALOG);

// Живой ответ 21.11 (сокращён).
const PLAN = [
  'Собрал черновик на 7 дней в августе, двое, вулканы и море.',
  '',
  '- День 1. Прилёт днём, размещение, акклиматизация',
  '- День 2. Восхождение на вулкан Горелый и лавовые пещеры — 15 000 ₽ за человека (Андрей Запорожец, места есть на 11.08)',
  '- День 3. Отдых, термальные источники',
  '- День 4. Бухта Русская, морская прогулка — 20 000 ₽ за человека (дату подтверждает оператор)',
  '- День 7. Сборы, трансфер в аэропорт, вылет',
].join('\n');

describe('карточки — туры из текста', () => {
  it('план «Горелый + бухта Русская» → ровно эти два тура, по порядку дней', () => {
    const named = toursNamedInAnswer(PLAN, UNIVERSE);
    expect(named.map((t) => t.id)).toEqual(['70', '64']);
  });

  it('цена «15 000 ₽» чужой тур не узнаёт; вертолёты и «Вулканы 5 дней» не всплывают', () => {
    const ids = toursNamedInAnswer(PLAN, UNIVERSE).map((t) => t.id);
    expect(ids).not.toContain('5');
    expect(ids).not.toContain('119');
    expect(ids).not.toContain('98');
  });

  it('тур, названный только номером «тур ID110», тоже карточка', () => {
    const named = toursNamedInAnswer('- День 5. Облёт бухты (тур ID110, Лагуна Экспедиция)', UNIVERSE);
    expect(named.map((t) => t.id)).toEqual(['110']);
  });

  it('ответ без туров — без карточек', () => {
    expect(toursNamedInAnswer('Возьмите дождевик и термобельё.', UNIVERSE)).toEqual([]);
  });

  it('не больше потолка карточек', () => {
    const many = Array.from({ length: 12 }, (_, i) => `ID${i + 1}: "Уникальный маршрут номер ${i + 1} по Камчатке" от 1 000 ₽/чел.`).join('\n');
    const answer = Array.from({ length: 12 }, (_, i) => `- Уникальный маршрут номер ${i + 1} по Камчатке`).join('\n');
    expect(toursNamedInAnswer(answer, parseTourLines(many))).toHaveLength(NAMED_TOUR_CARDS_MAX);
  });
});

describe('туры в тексте — ссылками', () => {
  const tours = [
    { id: '70', title: 'Восхождение на вулкан Горелый и лавовые пещеры', href: '/catalog/tours/gorelyj' },
    { id: '64', title: 'Бухта Русская (морская прогулка)', href: '/catalog/tours/russkaya' },
  ];

  it('точное название и пересказ — ссылка на страницу тура, цена и оговорки на месте', () => {
    const out = linkNamedTours(PLAN, tours);
    expect(out).toContain('- День 2. [Восхождение на вулкан Горелый и лавовые пещеры](/catalog/tours/gorelyj) — 15 000 ₽ за человека');
    expect(out).toContain('- День 4. [Бухта Русская](/catalog/tours/russkaya), морская прогулка — 20 000 ₽ за человека');
  });

  it('ссылка ставится один раз и не вкладывается в уже готовую', () => {
    const once = linkNamedTours(PLAN, tours);
    expect(linkNamedTours(once, tours)).toBe(once);
    expect(once.match(/\]\(\/catalog\/tours\/gorelyj\)/g)).toHaveLength(1);
  });

  it('название в кавычках — ссылкой внутри кавычек', () => {
    const out = linkNamedTours('Ещё: «Бухта Русская (морская прогулка)» — Местечко Камчатка', tours);
    expect(out).toBe('Ещё: «[Бухта Русская (морская прогулка)](/catalog/tours/russkaya)» — Местечко Камчатка');
  });
});
