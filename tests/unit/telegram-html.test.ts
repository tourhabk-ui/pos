// @vitest-environment node
/**
 * Разметка Telegram HTML не рвётся срезом (05.09).
 *
 * Пост в ИИ-канал не ушёл: Bot API 400 «Can't find end tag corresponding to
 * start tag "blockquote"». Четыре отправителя резали текст вслепую
 * (`substring(0, 4096)` / `slice(0, 4000)`), и хвостовой закрывающий тег
 * отваливался. Один срез на всех — lib/notifications/telegram-html.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairTelegramHtml, telegramHtmlIssue, stripCodeFence, TELEGRAM_TEXT_LIMIT, TELEGRAM_CAPTION_LIMIT } from '@/lib/notifications/telegram-html';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('диагноз разметки', () => {
  it('сбалансированный пост — без замечаний', () => {
    expect(telegramHtmlIssue('<b>Заголовок</b>\n<a href="https://x">Читать →</a>\n<blockquote expandable>нюанс</blockquote>')).toBeNull();
  });

  it('незакрытый blockquote назван по имени', () => {
    expect(telegramHtmlIssue('<b>x</b> <blockquote expandable>оборвано')).toMatch(/не закрыт <blockquote>/);
  });

  it('закрывающий без пары и незнакомый тег тоже названы', () => {
    expect(telegramHtmlIssue('текст</b>')).toMatch(/без открывающего/);
    expect(telegramHtmlIssue('<div>x</div>')).toMatch(/<div> Telegram не знает/);
  });
});

describe('срез под потолок закрывает то, что открыл', () => {
  const para = 'слово '.repeat(50).trim();

  it('длинный пост с blockquote в хвосте — влезает и сбалансирован', () => {
    const text = `<b>AI-дайджест</b>\n${'абзац '.repeat(900)}\n<blockquote expandable>${para}</blockquote>`;
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT);
    const out = repairTelegramHtml(text);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(telegramHtmlIssue(out)).toBeNull();
    expect(out.endsWith('</blockquote>') || !out.includes('<blockquote')).toBe(true);
  });

  it('срез не попадает внутрь тега', () => {
    // Потолок ровно посреди <a href="...">.
    const head = 'x'.repeat(4040);
    const text = `${head} <a href="https://vedarai.ru/very/long/path">ссылка</a> хвост`;
    const out = repairTelegramHtml(text);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(out).not.toMatch(/<a href="[^"]*$/);
    expect(telegramHtmlIssue(out)).toBeNull();
  });

  it('короткий, но несбалансированный текст чинится без среза', () => {
    const out = repairTelegramHtml('<b>жирный <i>курсив</b> хвост');
    expect(telegramHtmlIssue(out)).toBeNull();
    expect(out).not.toMatch(/…$/);
  });

  it('лишний закрывающий выбрасывается, текст остаётся', () => {
    const out = repairTelegramHtml('привет</b> мир');
    expect(out).toBe('привет мир');
  });

  it('голый < в тексте экранируется — Bot API читает его как начало тега', () => {
    // Эта строка стояла здесь как «текст не тронут» и пинила поведение,
    // которое прод отверг 06.09: `Bot API 400: can't parse entities: Unclosed
    // start tag at byte offset 381`. Теги в том посте были сбалансированы —
    // ломал разбор голый `<` внутри текста. Документация Bot API требует
    // экранировать `<`, `>` и `&` в тексте; мы экранируем `<` и одинокий `&`.
    expect(repairTelegramHtml('Просто текст. 1 < 2 и 3 > 4.')).toBe('Просто текст. 1 &lt; 2 и 3 > 4.');
  });

  it('текст без угловых скобок не трогается вовсе', () => {
    expect(repairTelegramHtml('Просто текст про туры.')).toBe('Просто текст про туры.');
  });
});

describe('слепых срезов у отправителей больше нет', () => {
  const senders = [
    'lib/agents/scout-digest.ts',
    'lib/agents/scout-innovator.ts',
    'lib/agents/scout-ai-features.ts',
  ];
  for (const f of senders) {
    it(`${f}: text режется через repairTelegramHtml`, () => {
      const src = read(f);
      expect(src).not.toMatch(/text:\s*text\.(?:substring|slice)\(0,\s*4\d{3}\)/);
      expect(src).toMatch(/repairTelegramHtml\(text, /);
    });
  }
});

describe('случай ИИ-канала 06.09: Unclosed start tag', () => {
  it('теги остаются тегами, а текст вокруг экранируется', () => {
    const got = repairTelegramHtml('<b>Итог</b>: если x < 5, берём Claude & Co.');
    expect(got).toBe('<b>Итог</b>: если x &lt; 5, берём Claude &amp; Co.');
  });

  it('готовая сущность не экранируется второй раз', () => {
    // Иначе `&amp;` стало бы `&amp;amp;` — то самое двойное экранирование,
    // от которого в репозитории стоит отдельный сторож.
    expect(repairTelegramHtml('Иванов &amp; Ко, тире &#8212; тут')).toBe('Иванов &amp; Ко, тире &#8212; тут');
  });

  it('диагноз называет голый < , а не молчит', () => {
    expect(telegramHtmlIssue('текст с < внутри')).toMatch(/голый </);
    expect(telegramHtmlIssue('<b>всё хорошо</b>')).toBeNull();
  });

  it('ссылка с параметрами переживает экранирование', () => {
    const got = repairTelegramHtml('<a href="https://vedarai.ru/a?x=1&y=2">тур</a>');
    expect(got).toBe('<a href="https://vedarai.ru/a?x=1&y=2">тур</a>');
    expect(telegramHtmlIssue(got)).toBeNull();
  });
});

describe('markdown-ограждение не уходит в канал (06.09)', () => {
  it('строка ``` в конце выпуска снимается', () => {
    // Видно глазами в канале: выпуск заканчивался строкой из трёх backtick.
    // Telegram HTML о markdown не знает и печатает их как есть.
    const got = repairTelegramHtml('<b>Дайджест</b>\n- Пункт\n```');
    expect(got).toBe('<b>Дайджест</b>\n- Пункт');
  });

  it('открывающее ограждение с языком — тоже', () => {
    expect(stripCodeFence('```html\n<b>Итог</b>\n```')).toBe('<b>Итог</b>');
  });

  it('backtick посреди фразы остаётся: это текст, а не ограждение', () => {
    const line = 'Модель ответила ``` внутри строки — так и было';
    expect(stripCodeFence(line)).toBe(line);
  });

  it('на месте ограждения не остаётся дыры из пустых строк', () => {
    expect(stripCodeFence('<b>A</b>\n\n```\n\n<b>B</b>')).toBe('<b>A</b>\n\n<b>B</b>');
  });
});

describe('подпись к фото режется тем же правилом, что и текст (07.09)', () => {
  const SENDERS = [
    'lib/notifications/telegram-channel.ts',
    'app/api/telegram/webhook/route.ts',
  ];

  it('слепого среза подписи не осталось ни у одного отправителя', () => {
    // `caption.slice(0, 1024)` рвал теги и оставлял голый `<` — Bot API на
    // такую подпись отвечает 400, и пост, у которого фото ЕСТЬ, уходил голым
    // текстом. Ровно тот дефект, что дважды ронял пост в ИИ-канал, — просто
    // на другом отправителе, и потому пережил обе прошлые починки.
    const offenders = SENDERS.filter((f) => {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      return /caption\s*\.\s*slice\(/.test(src);
    });
    expect(offenders, `слепой срез подписи вернулся: ${offenders.join(', ')}`).toEqual([]);
  });

  it('каждый отправитель зовёт общий срез с лимитом подписи', () => {
    for (const f of SENDERS) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).toMatch(/repairTelegramHtml\(caption, TELEGRAM_CAPTION_LIMIT\)/);
    }
  });

  it('лимит подписи вчетверо меньше лимита сообщения', () => {
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096);
  });

  it('длинная подпись с тегами остаётся валидной и влезает', () => {
    const long = `<b>Тур</b> ${'слово '.repeat(400)}<a href="https://vedarai.ru/t/1">Подробности</a>`;
    const got = repairTelegramHtml(long, TELEGRAM_CAPTION_LIMIT);
    expect(got.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(telegramHtmlIssue(got)).toBeNull();
  });

  it('голый < в подписи экранируется — иначе Bot API 400', () => {
    const got = repairTelegramHtml('<b>Тур</b>: группа < 10 человек', TELEGRAM_CAPTION_LIMIT);
    expect(got).toContain('&lt; 10');
    expect(telegramHtmlIssue(got)).toBeNull();
  });
});
