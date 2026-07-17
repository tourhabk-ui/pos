/**
 * tests/unit/sos-detector.test.ts
 *
 * Детерминированная SOS-страховка: детектор ЧП в сообщениях пользователя
 * и префикс 112/МЧС к ответу ассистента. Ключевой контракт — блок приходит
 * даже когда весь AI-конвейер лежит (ответ — фолбэк-ошибка), а информационные
 * вопросы про опасности Камчатки НЕ триггерят SOS.
 */

import { describe, it, expect } from 'vitest';
import { detectEmergency, buildSosBlock, withSosBlock } from '@/lib/safety/sos-detector';

describe('detectEmergency — позитивные случаи (по категориям)', () => {
  const cases: Array<[string, string]> = [
    ['lost', 'Я заблудился на склоне, тропы не вижу'],
    ['lost', 'мы потерялись, сбились с тропы час назад'],
    ['lost', 'не знаю где я, кругом туман'],
    ['injury', 'Напарник сломал ногу, не может идти'],
    ['injury', 'у него идёт кровь, что делать'],
    ['injury', 'подвернула ногу на спуске, сильная боль'],
    ['injury', 'человек без сознания после падения'],
    ['bear', 'медведь рядом с палаткой, не уходит'],
    ['bear', 'на нас напал медведь'],
    ['bear', 'медведица идёт к нам с медвежатами'],
    ['ice', 'провалился под лёд на реке'],
    ['ice', 'лёд трещит подо мной'],
    ['avalanche', 'сошла лавина, товарища засыпало'],
    ['avalanche', 'попали в камнепад, одного ранило'],
    ['group_missing', 'группа не вернулась с маршрута к контрольному времени'],
    ['group_missing', 'муж не вернулся с восхождения'],
    ['freezing', 'мы замерзаем, застигла пурга'],
    ['distress', 'спасите, нужна срочная помощь'],
    ['distress', 'SOS мы на перевале'],
    ['distress', 'SOS'],
    ['distress', 'вызовите спасателей, случилось ЧП'],
  ];

  it.each(cases)('категория %s: "%s"', (category, text) => {
    const result = detectEmergency(text);
    expect(result.detected).toBe(true);
    expect(result.categories).toContain(category);
  });
});

describe('detectEmergency — негативные случаи (информационные вопросы)', () => {
  const cases = [
    'Расскажи про медведей Камчатки',
    'Где можно увидеть медведя на Курильском озере?',
    'Какая лавинная опасность на Авачинском в марте?',
    'Есть ли камнепады на маршруте к Мутновскому?',
    'Расскажи про площадку Медвежья на маршруте',
    'Хочу тур на Медвежье озеро',
    'Потерял перчатки, где купить новые в городе?',
    'Насколько крепкий лёд на Халактырке зимой?',
    'Помогите выбрать тур на вулкан',
    'Какие опасности на этом маршруте?',
    'Привет! Что посмотреть за 3 дня?',
    'Наш план поездки провалился, посоветуй что-то на замену',
    'Я провалился на экзамене, хочу развеяться в горах',
    '',
  ];

  it.each(cases)('не триггерит: "%s"', (text) => {
    expect(detectEmergency(text).detected).toBe(false);
  });

  it('граница предложения разрывает контекст угрозы', () => {
    // «напали» относится ко второму предложению, не к медведям
    expect(detectEmergency('Тут водятся медведи. Комары на нас напали вчера').detected).toBe(false);
  });
});

describe('buildSosBlock', () => {
  it('всегда содержит 112 и ссылку на SOS, без невериф. региональных номеров', () => {
    const block = buildSosBlock(['lost']);
    expect(block).toContain('112');
    expect(block).toContain('vedarai.ru/sos');
    // Региональные номера не верифицированы — их в блоке быть не должно.
    expect(block).not.toMatch(/4152/);
  });

  it('добавляет советы по категориям, не больше трёх', () => {
    const block = buildSosBlock(['bear', 'injury', 'lost', 'freezing']);
    expect(block).toContain('Не бегите');
    expect(block).toContain('кровотечение');
    expect(block).toContain('Оставайтесь на месте');
    expect(block).not.toContain('укрытие от ветра');
  });
});

describe('withSosBlock', () => {
  it('обычный вопрос — ответ не тронут', () => {
    const { text, emergency } = withSosBlock('Авачинский — красивый вулкан.', 'Расскажи про Авачинский');
    expect(emergency).toBe(false);
    expect(text).toBe('Авачинский — красивый вулкан.');
  });

  it('ЧП + мёртвый AI-конвейер: SOS-блок приходит поверх фолбэк-ошибки', () => {
    const { text, emergency } = withSosBlock(
      'Извините, сервис временно недоступен. Попробуйте позже.',
      'провалился под лёд, замерзаю',
    );
    expect(emergency).toBe(true);
    expect(text).toContain('112');
    expect(text).toContain('vedarai.ru/sos');
    expect(text.indexOf('112')).toBeLessThan(text.indexOf('Извините'));
  });

  it('модель сама дала 112 и МЧС — не дублируем блок', () => {
    const answer = 'Срочно звоните 112, дежурная часть МЧС уже предупреждена. Не двигайтесь с места.';
    const { text, emergency } = withSosBlock(answer, 'я заблудился в лесу');
    expect(emergency).toBe(true);
    expect(text).toBe(answer);
  });

  it('«112» как кусок цены не глушит блок', () => {
    const answer = 'Тур на Толбачик стоит 11200 рублей с человека.';
    const { text, emergency } = withSosBlock(answer, 'я заблудился, сколько стоит эвакуация');
    expect(emergency).toBe(true);
    expect(text).toContain('ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ');
    expect(text).toContain('vedarai.ru/sos');
  });

  it('голое «112» без МЧС в ответе — блок всё равно добавляется (перестраховка)', () => {
    const answer = 'Звоните 112.';
    const { text } = withSosBlock(answer, 'спасите, замерзаю');
    expect(text).toContain('vedarai.ru/sos');
  });
});
