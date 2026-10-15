/**
 * tests/unit/sos-detector.test.ts
 *
 * Детерминированная SOS-страховка: детектор ЧП в сообщениях пользователя
 * и префикс 112/МЧС к ответу ассистента. Ключевой контракт — блок приходит
 * даже когда весь AI-конвейер лежит (ответ — фолбэк-ошибка), а информационные
 * вопросы про опасности Камчатки НЕ триггерят SOS.
 */

import { describe, it, expect } from 'vitest';
import { detectEmergency, buildSosBlock, withSosBlock, type EmergencyCategory } from '@/lib/safety/sos-detector';

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

describe('buildSosBlock — язык блока (аудит 15.10, WID-lang)', () => {
  const ALL: EmergencyCategory[] = ['lost', 'injury', 'bear', 'ice', 'avalanche', 'group_missing', 'freezing', 'distress'];

  it('без языка — русский блок, слово в слово как с явным ru (прежние вызывающие не меняются)', () => {
    for (const c of ALL) expect(buildSosBlock([c])).toBe(buildSosBlock([c], 'ru'));
    expect(withSosBlock('ответ', 'я заблудился')).toEqual(withSosBlock('ответ', 'я заблудился', 'ru'));
  });

  it('en и zh: 112, ссылка на SOS, совет по каждой категории — без русских слов и без региональных номеров', () => {
    for (const lang of ['en', 'zh'] as const) {
      for (const c of ALL) {
        const block = buildSosBlock([c], lang);
        expect(block).toMatch(/(?<!\d)112(?!\d)/);
        expect(block).toContain('vedarai.ru/sos');
        expect(block).not.toMatch(/[а-яё]/i);
        expect(block).not.toMatch(/4152/);
        // Совет категории на месте: строк столько же, сколько у русского блока.
        expect(block.split('\n')).toHaveLength(buildSosBlock([c]).split('\n').length);
      }
    }
    expect(buildSosBlock(['bear'], 'zh')).toMatch(/[\u4e00-\u9fff]/);
    expect(buildSosBlock(['bear'], 'en')).toContain('Do not run');
  });

  it('withSosBlock с языком: блок на нём, ответ модели не тронут', () => {
    const { text, emergency } = withSosBlock('请留在原地。', 'SOS', 'zh');
    expect(emergency).toBe(true);
    expect(text.startsWith(buildSosBlock(['distress'], 'zh'))).toBe(true);
    expect(text.endsWith('请留在原地。')).toBe(true);
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

describe('detectEmergency — пропуски, найденные разбором 24.09', () => {
  for (const [text, category] of [
    ['Друг ушёл вперёд по тропе четыре часа назад и не отвечает на звонки', 'group_missing'],
    ['жена не выходит на связь с утра', 'group_missing'],
    ['ребёнок упал и не встаёт', 'injury'],
    ['не могу дышать на высоте', 'injury'],
    ['ошпарило паром у гейзера', 'injury'],
    ['напарник задыхается', 'injury'],
    ['сын получил ожог у источника', 'injury'],
    ['помогите', 'distress'],
    ['Помогите!!!', 'distress'],
    ['помогите, срочно', 'distress'],
  ] as const) {
    it(text, () => {
      expect(detectEmergency(text).categories).toContain(category);
    });
  }

  it('«помогите» внутри обычной просьбы — не ЧП', () => {
    for (const text of ['помогите выбрать тур на Авачинский', 'друг не отвечает, какой тур выбрать', 'как не упасть на курумнике']) {
      expect(detectEmergency(text).detected, text).toBe(false);
    }
  });
});

// Ревью WID-lang (15.10): окно виджета говорит с посетителем на его языке, и
// серверный блок 112 обязан узнавать беду не только по-русски. Те же правила
// точности: опасное слово — только с признаком угрозы в той же фразе.
describe('detectEmergency — английский и китайский', () => {
  const positive: Array<[string, EmergencyCategory]> = [
    ['We are lost near the volcano', 'lost'],
    ["I'm lost, phone at 10%", 'lost'],
    ["We don't know where we are", 'lost'],
    ['我们迷路了', 'lost'],
    ['不知道我们在哪', 'lost'],
    ['My friend is injured and bleeding badly', 'injury'],
    ['He fell and cannot get up', 'injury'],
    ['朋友受伤了，腿骨折', 'injury'],
    ['他摔倒了起不来', 'injury'],
    ['A bear is chasing us', 'bear'],
    ['熊在追我们', 'bear'],
    ['我们被熊袭击了', 'bear'],
    ['My son fell through the ice', 'ice'],
    ['孩子掉进冰窟窿', 'ice'],
    ['Two people buried by an avalanche', 'avalanche'],
    ['我们遇到雪崩', 'avalanche'],
    ["My husband hasn't come back from the trail", 'group_missing'],
    ['队友没回来，联系不上', 'group_missing'],
    ['Signs of hypothermia, we are freezing', 'freezing'],
    ['快冻死了', 'freezing'],
    ['Help us please', 'distress'],
    ['救命！', 'distress'],
    ['请叫救援', 'distress'],
  ];
  it.each(positive)('срабатывает: "%s" → %s', (text, category) => {
    const r = detectEmergency(text);
    expect(r.detected).toBe(true);
    expect(r.categories).toContain(category);
  });

  const informational = [
    'Are there bears near the Kuril Lake?',
    'Is the ice thick enough in winter?',
    'What is the avalanche risk in March?',
    'Help me choose a volcano tour',
    'I lost my gloves, where can I buy new ones?',
    '熊会靠近营地吗？',
    '堪察加有熊吗？',
    '雪崩风险大吗？',
    '帮我选一个火山旅游',
    '我的行李丢了，去哪里买新的？',
  ];
  it.each(informational)('не срабатывает на вопросе: "%s"', (text) => {
    expect(detectEmergency(text).detected).toBe(false);
  });

  it('блок 112 на языке посетителя приходит на китайское «迷路»', () => {
    const r = withSosBlock('好的。', '我们迷路了', 'zh');
    expect(r.emergency).toBe(true);
    expect(r.text).toMatch(/112/);
    expect(r.text).toMatch(/请拨打 112/);
  });
});
