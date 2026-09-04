/**
 * Описание тура СОБИРАЕТСЯ из его полей, а не сочиняется моделью.
 *
 * Второй из двух блокеров выкладки на чужие витрины: из восьми живых туров у
 * шести описание короче 300 знаков. Чинить это было некому — агент Editor
 * переписывает описания МЕСТ и МАРШРУТОВ, до operator_tours он не дотягивается.
 *
 * Ключевое решение: текст детерминированно собирается из того, что оператор
 * УЖЕ записал. Просить модель «напиши описание тура» значит заказать выдумку
 * про незабываемые виды и опытных гидов, которых мы не проверяли, и подписать
 * её именем оператора (§4.0: обязательное поле, которое нечем заполнить,
 * заполняется враньём). Сборка вдобавок работает при мёртвых провайдерах —
 * 04.09 живых было двое из восемнадцати.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeTourDescription, seasonPhrase, durationPhrase, programSteps,
  MIN_DESCRIPTION_CHARS, type TourFacts,
} from '@/lib/tours/describe';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/tour-describe/route.ts'), 'utf-8');

const rich: TourFacts = {
  title: 'Восхождение на Авачинский вулкан',
  location_name: 'Авачинский перевал',
  duration_hours: 10,
  difficulty: 'medium',
  season_start: '2026-06-15',
  season_end: '2026-09-20',
  max_participants: 12,
  weather_dependent: true,
  program: [
    { title: 'Выезд', text: 'ранний старт из города, дорога по сухому руслу' },
    { title: 'Подъём', text: 'набор высоты по тропе, привалы каждый час' },
    { title: 'Кратер', text: 'осмотр кратера и фумарол' },
  ],
  included: ['Трансфер', 'Гид', 'Перекус на маршруте'],
  what_to_bring: ['Треккинговые ботинки', 'Ветрозащита', 'Вода 2 литра'],
  pickup_type: 'hotel_pickup',
  pickup_details: 'Забираем из Петропавловска и Елизова',
};

describe('сборка описания', () => {
  it('на полных данных даёт текст длиннее порога витрин', () => {
    const r = composeTourDescription(rich);
    expect(r.text, `собралось ${r.chars} знаков`).not.toBeNull();
    expect(r.chars).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    expect(r.missing).toEqual([]);
  });

  it('в тексте только факты оператора — ни одного украшения от себя', () => {
    const text = composeTourDescription(rich).text!;
    // Всё, что попало в текст, прослеживается ко входу.
    expect(text).toContain('Авачинский перевал');
    expect(text).toContain('Кратер');
    expect(text).toContain('треккинговые ботинки');
    // Слова, которых во входе нет, появиться не могут по построению.
    for (const invented of ['незабываем', 'уникальн', 'опытный гид', 'лучший', 'непередаваем']) {
      expect(text.toLowerCase(), `в текст просочилось «${invented}»`).not.toContain(invented);
    }
  });

  it('называет, из каких полей собран: с этим можно спорить', () => {
    const r = composeTourDescription(rich);
    expect(r.used).toContain('program');
    expect(r.used).toContain('included');
    expect(r.used).toContain('pickup');
  });

  it('данных мало — текста НЕТ, и названо, чего не хватает', () => {
    const r = composeTourDescription({ title: 'Морская прогулка', location_name: 'Авачинская бухта' });
    expect(r.text, 'дописали воду до порога вместо честного отказа').toBeNull();
    expect(r.missing).toContain('program');
    expect(r.missing).toContain('included');
    expect(r.chars).toBeLessThan(MIN_DESCRIPTION_CHARS);
  });

  it('одинаковый вход — одинаковый выход: сборка не зависит от провайдеров', () => {
    expect(composeTourDescription(rich).text).toBe(composeTourDescription(rich).text);
  });
});

describe('частные разборы', () => {
  it('сезон читается из даты и склоняется по-русски', () => {
    expect(seasonPhrase('2026-06-15', '2026-09-20')).toBe('Сезон — с 15 июня по 20 сентября');
    expect(seasonPhrase('2026-06-15', null)).toBe('Сезон начинается 15 июня');
    expect(seasonPhrase(null, null)).toBeNull();
    // Мусор не превращается в дату.
    expect(seasonPhrase('лето', null)).toBeNull();
    expect(seasonPhrase('2026-13-40', null)).toBeNull();
  });

  it('часы и дни — разные вопросы, не смешиваются', () => {
    expect(durationPhrase({ title: 'т', duration_hours: 1 })).toBe('Тур занимает около 1 час');
    expect(durationPhrase({ title: 'т', duration_hours: 3 })).toBe('Тур занимает около 3 часа');
    expect(durationPhrase({ title: 'т', duration_hours: 10 })).toBe('Тур занимает около 10 часов');
    expect(durationPhrase({ title: 'т', duration_hours: 8, multi_day_count: 3 })).toBe('Поездка занимает 3 дня');
    expect(durationPhrase({ title: 'т' })).toBeNull();
  });

  it('чужая форма программы не роняет сборку и не считается шагами', () => {
    expect(programSteps(null)).toEqual([]);
    expect(programSteps('строка')).toEqual([]);
    expect(programSteps([{ text: 'без заголовка' }, null, 42])).toEqual([]);
    expect(programSteps([{ title: ' Выезд ', text: ' рано ' }])).toEqual([{ title: 'Выезд', text: 'рано' }]);
  });
});

describe('запись: границы те же, что у правки координат', () => {
  it('пишет только туда, где описание короче порога — и проверяет это в UPDATE', () => {
    expect(ROUTE).toMatch(/COALESCE\(LENGTH\(ot\.description\), 0\) < \$1/);
    expect(ROUTE, 'между переписью и записью оператор мог дописать описание сам')
      .toMatch(/AND COALESCE\(LENGTH\(description\), 0\) < \$3/);
  });

  it('сухой прогон по умолчанию, партия не больше десяти, причина обязательна', () => {
    expect(ROUTE).toMatch(/dry_run: z\.boolean\(\)\.default\(true\)/);
    expect(ROUTE).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(10\)/);
    expect(ROUTE).toMatch(/reason: z\.string\(\)\.min\(10\)/);
  });

  it('старое описание возвращается в ответе — это откат', () => {
    expect(ROUTE).toMatch(/before: r\.description/);
  });

  it('перепись различает «соберётся» и «данных не хватит»', () => {
    expect(ROUTE).toMatch(/outcome: c\.text \? 'composable' : 'not_enough_data'/);
    expect(ROUTE).toMatch(/missing_by_field/);
  });

  it('модель в этом пути не участвует вовсе', () => {
    expect(ROUTE, 'в сборку описания просочился вызов модели').not.toMatch(/callAI|generateText|openai|anthropic/i);
  });
});
