/**
 * Тело предупреждения МЧС лежит не в description.
 *
 * 10.08 владелец прислал предупреждение о циклоне. Оно не дошло до платформы.
 * Первую причину — отсутствие погодной категории — починили. Оказалось, что
 * до классификатора текст всё равно не доезжал.
 *
 * Проба живого фида, раздел «Штормовые и экстренные предупреждения»:
 *
 *   <title>Экстренное предупреждение на 11 августа 2026 г.
 *          (опасное метеорологическое явление)</title>
 *   <description></description>            ← ПУСТО
 *   <yandex:full-text>&lt;p&gt;К берегам Камчатки приближается
 *          охотоморский циклон…&lt;/p&gt;</yandex:full-text>
 *
 * Мы читали только `description`. То есть видели заголовок «экстренное
 * предупреждение на 11 августа» — без единого слова о том, что за явление,
 * где и кому. Из 40 элементов фида классифицировались 5: остальные приходили
 * пустыми не потому, что там нечего сказать, а потому, что мы смотрели не в
 * тот узел.
 *
 * В потерянном тексте МЧС писала прямо: «повышена вероятность пропажи,
 * травмирования и гибели людей вне населённых пунктов, осуществляющих
 * туристическую и спортивную деятельность».
 *
 * Фикстура — настоящая разметка из фида, снятая пробой, вместе с пустым
 * <description> и экранированным HTML внутри full-text.
 */
import { describe, it, expect } from 'vitest';
import { parseMchsItems, classifyMchsItems } from '@/lib/services/safety/seismic-parser';
import { textFromEscapedHtml } from '@/lib/services/safety/kvert-vona';

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:yandex="http://news.yandex.ru">
<channel>
  <title>Экстренные предупреждения</title>
  <item>
    <title>Экстренное предупреждение на 11 августа 2026 г. (опасное метеорологическое явление)</title>
    <description></description>
    <pubDate>Mon, 10 Aug 26 16:40:00 +1200</pubDate>
    <link>https://41.mchs.gov.ru/deyatelnost/press-centr/operativnaya-informaciya/shtormovye-i-ekstrennye-preduprezhdeniya/5808118</link>
    <yandex:full-text>&lt;p style=&quot;text-align: justify;&quot;&gt;К берегам Камчатки приближается охотоморский циклон. По данным Камчатского управления по гидрометеорологии и мониторингу окружающей среды, в первой половине ночи 11 августа в Петропавловске-Камчатском, местами в Елизовском, Усть-Большерецком и на юге Мильковского муниципальных округов прогнозируется очень сильный дождь.&lt;/p&gt;&lt;p&gt;Исходя из прогноза, повышена вероятность пропажи, травмирования и гибели людей вне населённых пунктов, осуществляющих туристическую и спортивную деятельность.&lt;/p&gt;&lt;p&gt;Туристическим группам и охотникам рекомендуется воздержаться от выхода на маршруты.&lt;/p&gt;</yandex:full-text>
  </item>
</channel>
</rss>`;

describe('разбор элемента фида берёт текст оттуда, где он есть', () => {
  const [item] = parseMchsItems(FEED);

  it('элемент вообще разобран', () => {
    expect(item).toBeDefined();
    expect(item.title).toContain('Экстренное предупреждение на 11 августа');
  });

  it('пустой description не оставляет элемент без текста', () => {
    // Ровно то место, где терялся циклон.
    expect(item.desc).not.toBe('');
    expect(item.desc).toContain('охотоморский циклон');
  });

  it('разметка снята, а не показана человеку как текст', () => {
    expect(item.desc).not.toContain('&lt;');
    expect(item.desc).not.toContain('<p');
    expect(item.desc).not.toContain('text-align');
  });

  it('обычный непустой description по-прежнему главнее', () => {
    const feed = FEED.replace('<description></description>', '<description>Короткая сводка</description>');
    expect(parseMchsItems(feed)[0].desc).toBe('Короткая сводка');
  });

  it('content:encoded читается так же — это тот же приём в обычных RSS', () => {
    const feed = FEED
      .replace(/<yandex:full-text>[\s\S]*?<\/yandex:full-text>/, '<content:encoded>&lt;p&gt;Ожидается метель.&lt;/p&gt;</content:encoded>');
    expect(parseMchsItems(feed)[0].desc).toBe('Ожидается метель.');
  });
});

describe('после разбора предупреждение доходит до тревоги', () => {
  const [item] = parseMchsItems(FEED);
  const events = classifyMchsItems(item.id, item.title, item.desc, item.pubDate, item.link);

  it('событие рождается', () => {
    expect(events).not.toHaveLength(0);
  });

  it('severity не ниже порога пуша', () => {
    expect(events[0].severity).toBeGreaterThanOrEqual(2);
  });

  it('зоны взяты из перечисленных округов', () => {
    expect(events[0].affected_zones).toEqual(
      expect.arrayContaining(['avachinsky', 'western', 'northern']),
    );
  });

  it('без текста тот же заголовок не даёт ничего — цена одного узла', () => {
    // Так фид читался до правки: заголовок есть, текста нет, событий ноль.
    expect(classifyMchsItems(item.id, item.title, '', item.pubDate, item.link)).toHaveLength(0);
  });
});

describe('экранированную разметку разворачиваем ровно один раз', () => {
  it('текст внутри тегов достаётся', () => {
    expect(textFromEscapedHtml('&lt;p&gt;Метель&lt;/p&gt;')).toBe('Метель');
  });

  it('записанная автором сущность не превращается в разметку', () => {
    // `&amp;lt;` — это способ НАПИСАТЬ строку «&lt;», а не тег. Второй проход
    // разворачивания сделал бы из неё символ «<»; на этом CodeQL уже ловил
    // соседний парсер, и повторять нельзя.
    expect(textFromEscapedHtml('&amp;lt;p&amp;gt;')).toBe('&lt;p&gt;');
  });

  it('пустой вход — пустой выход, без исключения', () => {
    expect(textFromEscapedHtml('')).toBe('');
  });
});
