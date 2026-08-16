/**
 * Парсер сайтов и Telegram-каналов потенциальных партнёров (#66, фаза 1).
 *
 * Разбор — чистая функция без сети: t.me с Timeweb гео-закрыт, HTML канала
 * приносит GitHub Actions (тот же путь, что у safety-ingest), а сервер только
 * разбирает. Значит тесты гоняют настоящую разметку без всякой сети.
 *
 * Сторож держит то, что стоит доверия партнёра:
 *  - словарь активностей ОБЩИЙ с платформой, свой не заводится;
 *  - в «цены» не попадают годы, высоты и куски телефонов;
 *  - контакты нормализуются, мусор отсеивается;
 *  - профиль «одна-две активности» отличается от «не поняли».
 */
import { describe, it, expect } from 'vitest';
import {
  htmlToText, extractContacts, detectActivities, extractPrices,
  parseOperatorSite, parseTelegramChannel, prospectSize,
} from '@/lib/partners/prospect-parse';
import { ACTIVITY_LABEL } from '@/lib/planner-constants';

describe('htmlToText', () => {
  it('выкидывает скрипты и стили целиком, а не по тегам', () => {
    const html = '<div>Сплав<script>var a="Рыбалка"</script><style>.x{}</style> по Быстрой</div>';
    const text = htmlToText(html);
    expect(text).toContain('Сплав');
    expect(text).toContain('по Быстрой');
    expect(text).not.toContain('Рыбалка');
    expect(text).not.toContain('var a');
  });

  it('разворачивает сущности и не склеивает блоки в одно слово', () => {
    expect(htmlToText('<p>Уха</p><p>Баня</p>')).toMatch(/Уха\s+Баня/);
    expect(htmlToText('<p>Цена &lt; 5000 &amp; место</p>')).toContain('< 5000 & место');
  });

  // Две находки CodeQL на PR #1232 — обе настоящие.
  it('не раскрывает сущности дважды: &amp;lt; остаётся текстом, не тегом', () => {
    // Цепочка replace превращала это в «<b>», то есть литеральный текст
    // автора становился разметкой.
    expect(htmlToText('<p>Пишут так: &amp;lt;b&amp;gt;</p>')).toContain('&lt;b&gt;');
  });

  it('закрывающий тег скрипта с пробелом, переводом строки или мусором режется', () => {
    // Браузер принимает все три формы: атрибуты закрывающего тега он
    // игнорирует. Пока регулярка требовала ровно `</script>`, тело скрипта
    // считалось текстом страницы.
    expect(htmlToText('<div>Сплав<script>var secret="утечка"</script >конец</div>'))
      .not.toContain('утечка');
    expect(htmlToText('<div>Сплав<script>var s="утечка2"</script\n>конец</div>'))
      .not.toContain('утечка2');
    expect(htmlToText('<div>Сплав<script>var s="утечка3"</script\t\n bar>конец</div>'))
      .not.toContain('утечка3');
    expect(htmlToText('<div>Сплав<style>.a{content:"утечка4"}</style foo>конец</div>'))
      .not.toContain('утечка4');
  });

  it('обрезанный HTML с незакрытым скриптом не отдаёт его тело как текст', () => {
    // Потолок MAX_HTML режет страницу где придётся — хвост скрипта не текст.
    expect(htmlToText('<div>Сплав</div><script>var payload="мусор"'))
      .not.toContain('мусор');
  });
});

describe('контакты', () => {
  it('российские номера в любых разделителях приводятся к +7', () => {
    const c = extractContacts('Звоните +7 (914) 782-22-22 или 8-924-790-19-11, ещё 79147817114');
    expect(c.phones).toContain('+79147822222');
    expect(c.phones).toContain('+79247901911');
    expect(c.phones).toContain('+79147817114');
  });

  it('год и цена номером не становятся', () => {
    const c = extractContacts('Работаем с 2019 года, тур стоит 13 000 рублей');
    expect(c.phones).toEqual([]);
  });

  it('Telegram: и ссылка, и @ник; веб-превью t.me/s/ не считается аккаунтом', () => {
    const c = extractContacts('Пишите @kamrafting или https://t.me/kamchatka_raft , канал t.me/s/kamchatka_raft');
    expect(c.telegram).toContain('kamrafting');
    expect(c.telegram).toContain('kamchatka_raft');
    expect(c.telegram).not.toContain('s');
  });

  it('WhatsApp и почта; соцсети не выдаются за сайт партнёра', () => {
    const c = extractContacts('https://wa.me/79147822222 info@fishingkam.ru https://vk.com/club1 https://fishingkam.ru/tours');
    expect(c.whatsapp).toContain('+79147822222');
    expect(c.emails).toContain('info@fishingkam.ru');
    expect(c.websites).toContain('fishingkam.ru');
    expect(c.websites).not.toContain('vk.com');
  });
});

describe('активности — общий словарь платформы', () => {
  it('каждый распознанный id есть в ACTIVITY_LABEL', () => {
    const found = detectActivities(
      'Сплав по реке, рыбалка на кижуча, восхождение на вулкан, морская прогулка к касаткам, термальные источники',
    );
    expect(found.length).toBeGreaterThan(0);
    for (const id of found) expect(ACTIVITY_LABEL[id]).toBeTruthy();
  });

  it('узнаёт малого оператора по одной активности', () => {
    const found = detectActivities('Однодневный сплав по реке Быстрой с ухой и баней');
    expect(found).toEqual(['rafting']);
    expect(prospectSize(found)).toBe('small');
  });

  it('многопрофильного отличает от малого, а пустоту — от нуля активностей', () => {
    const many = detectActivities('Сплавы, рыбалка, вертолётные экскурсии, снегоходы, медведи');
    expect(prospectSize(many)).toBe('multi');
    expect(prospectSize(detectActivities('Мы есть'))).toBe('unknown');
  });
});

describe('цены', () => {
  it('берёт только числа с валютной приметой', () => {
    expect(extractPrices('Тур от 13 000 руб, высота 2741 метр, с 2019 года'))
      .toEqual([13000]);
  });

  it('несколько цен — по возрастанию, мусорные величины отсечены', () => {
    expect(extractPrices('от 28 000 ₽, доплата 300 р., спецтур 150000 рублей'))
      .toEqual([28000, 150000]);
  });
});

describe('сайт оператора', () => {
  const SITE = `<!doctype html><html><head>
    <title>Камчатка Семейный Рафтинг — сплавы по Быстрой</title>
    <meta property="og:description" content="Однодневные сплавы для семей с детьми">
    </head><body>
    <h1>Сплав по реке Быстрая</h1>
    <p>Стоимость 13 000 руб/чел. Уха из лосося, баня.</p>
    <p>Телефон: +7 914 781-71-14, почта raft@example.ru</p>
    </body></html>`;

  it('вытаскивает заголовок, описание, активность, цену и контакты', () => {
    const p = parseOperatorSite(SITE);
    expect(p.title).toContain('Камчатка Семейный Рафтинг');
    expect(p.description).toContain('семей');
    expect(p.activities).toEqual(['rafting']);
    expect(p.prices).toEqual([13000]);
    expect(p.contacts.phones).toContain('+79147817114');
    expect(p.contacts.emails).toContain('raft@example.ru');
    expect(p.textLength).toBeGreaterThan(50);
  });

  it('пустая страница не притворяется богатой', () => {
    const p = parseOperatorSite('<html><body></body></html>');
    expect(p.activities).toEqual([]);
    expect(p.prices).toEqual([]);
    expect(p.textLength).toBe(0);
  });
});

describe('Telegram-канал (публичное веб-превью)', () => {
  // Форма разметки t.me/s/<channel>: посты в tgme_widget_message_text.
  const TG = `<html><head>
    <meta property="og:title" content="Камчатка Сплавы">
    <meta property="og:description" content="Сплавы и рыбалка на Быстрой">
    <meta property="og:url" content="https://t.me/s/kamraft">
    </head><body>
    <div class="tgme_widget_message_text js-message_text">Завтра сплав, осталось 2 места. 13 000 руб с человека.</div>
    <div class="tgme_widget_message_text js-message_text">Рыбалка на кижуча открыта. Запись: +7 924 790-19-11</div>
    </body></html>`;

  it('читает посты, а не только шапку', () => {
    const p = parseTelegramChannel(TG);
    expect(p.posts).toHaveLength(2);
    expect(p.posts[0]).toContain('осталось 2 места');
  });

  it('активности и цены берутся из постов', () => {
    const p = parseTelegramChannel(TG);
    expect(p.activities).toContain('rafting');
    expect(p.activities).toContain('fishing');
    expect(p.prices).toEqual([13000]);
  });

  it('телефон из поста подхватывается, имя канала распознаётся', () => {
    const p = parseTelegramChannel(TG);
    expect(p.contacts.phones).toContain('+79247901911');
    expect(p.channel).toBe('kamraft');
  });

  it('канал без постов не выдаёт выдуманного профиля', () => {
    const p = parseTelegramChannel('<html><body></body></html>');
    expect(p.posts).toEqual([]);
    expect(p.activities).toEqual([]);
    expect(p.channel).toBeNull();
  });
});
