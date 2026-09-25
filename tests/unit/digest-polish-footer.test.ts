/**
 * Оформление постов AI-канала (24.09, снимки владельца).
 *
 * 1. Числа по-русски: «2,000+», «3,656», «1,702,790» — английская запись
 *    разрядов, которую модель переносит из источника дословно.
 * 2. Оборванный хвост: дайджест кончился на «…представила кита» — модель
 *    упёрлась в бюджет токенов. Обрывок отрезается и называется в отчёте.
 * 3. Три реферальные ссылки владельца в конце каждого нашего поста в
 *    AI-канал — одним подвалом из одного источника, после фактчека.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ruThousands, trimUnfinishedTail, polishDigest } from '@/lib/text/digest-polish';
import { AI_CHANNEL_REFERRALS, aiChannelFooter, withAiChannelFooter } from '@/lib/notifications/ai-channel-footer';
import { repairTelegramHtml, telegramHtmlIssue, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from '@/lib/notifications/telegram-html';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const NB = '\u00A0';

describe('числа по-русски', () => {
  it('случаи из поста 24.09', () => {
    expect(ruThousands('Библиотека из 2,000+ голосов')).toBe('Библиотека из 2000+ голосов');
    expect(ruThousands('на 3,656 продакшн-моделях')).toBe('на 3656 продакшн-моделях');
    expect(ruThousands('1,702,790 из 1,702,797 граней'))
      .toBe(`1${NB}702${NB}790 из 1${NB}702${NB}797 граней`);
  });

  it('десятичные дроби, версии и проценты не трогаются', () => {
    for (const s of ['рост 3,5 млн', 'доля 0,125', 'Gemini 3.8 Flash', 'точность 12,5%', 'в 9× быстрее']) {
      expect(ruThousands(s), s).toBe(s);
    }
  });

  it('внутри тегов и адресов — не трогается', () => {
    const html = '<a href="https://x.dev/?ids=1,234,567">1,234,567 строк</a>';
    expect(ruThousands(html)).toBe(`<a href="https://x.dev/?ids=1,234,567">1${NB}234${NB}567 строк</a>`);
  });
});

describe('оборванный хвост', () => {
  const OWNER_DIGEST_24_09 = [
    '<b>Дайджест 24.09.2026</b>',
    '',
    '<b>Референсы и рынок</b>',
    '- Product Hunt: minimi 2.0.',
    '',
    '<b>Камчатка</b>',
    '- Издательский холдинг «Новая книга» подвёл итоги 30 лет.',
    '- Спасатели МЧС на Камчатке отработали беспарашютное десантирование.',
    '- Корпорация развития Камчатки представила кита',
  ].join('\n');

  it('живой случай 24.09: обрывок отрезан, остальное на месте', () => {
    const { text, dropped } = trimUnfinishedTail(OWNER_DIGEST_24_09);
    expect(dropped).toEqual(['- Корпорация развития Камчатки представила кита']);
    expect(text).toMatch(/беспарашютное десантирование\.$/);
    expect(text).toContain('<b>Камчатка</b>');
  });

  it('раздел, оставшийся без пунктов, уходит вместе с обрывком', () => {
    const src = '<b>Дайджест</b>\n\n<b>AI</b>\n- Первый пункт.\n- Второй пункт.\n\n<b>Камчатка</b>\n- Корпорация представила кита';
    const { text, dropped } = trimUnfinishedTail(src);
    expect(dropped).toHaveLength(2);
    expect(text.endsWith('- Второй пункт.')).toBe(true);
  });

  it('законченный выпуск не трогается', () => {
    const src = '<b>Дайджест</b>\n- Первый.\n- Второй.\n- Третий.';
    expect(trimUnfinishedTail(src)).toEqual({ text: src, dropped: [] });
  });

  it('модель пишет без точек — последний пункт не считается обрывом', () => {
    const src = '<b>Рынок</b>\n- Product Hunt: CtrlOps 1.0\n- Product Hunt: Harness Manager\n- Product Hunt: minimi 2.0';
    expect(trimUnfinishedTail(src).dropped).toEqual([]);
  });

  it('AI-пост кончается ссылкой или цитатой — это законченный пост', () => {
    const post = '<b>AI-дайджест · 24 сентября</b>\n\n<b>Заголовок</b>\nФакт первый.\n<b>Почему важно:</b> вывод.\n<a href="https://a.dev">Читать →</a>';
    expect(trimUnfinishedTail(post).dropped).toEqual([]);
    expect(trimUnfinishedTail(`${post}\n\n<blockquote expandable>Третий материал.</blockquote>`).dropped).toEqual([]);
  });

  it('незакрытая цитата — обрыв: отрезается от открывающего тега, HTML остаётся целым', () => {
    const post = '<b>Заголовок</b>\nФакт первый.\n<a href="https://a.dev">Читать →</a>\n\n<blockquote expandable>Contrastive-LM выпустила CLM-8B, Если вы сей';
    const { text, dropped } = trimUnfinishedTail(post);
    expect(dropped[0]).toMatch(/^<blockquote expandable>/);
    expect(telegramHtmlIssue(text)).toBeNull();
    expect(text.endsWith('</a>')).toBe(true);
  });

  it('polishDigest: сначала хвост, потом числа', () => {
    const { text, dropped } = polishDigest('<b>AI</b>\n- Совпали 1,702,790 граней.\n- Ещё один факт.\n- Оборван');
    expect(dropped).toEqual(['- Оборван']);
    expect(text).toContain(`1${NB}702${NB}790`);
  });
});

describe('подвал с реферальными ссылками', () => {
  it('три ссылки владельца, ровно как он их дал', () => {
    expect(AI_CHANNEL_REFERRALS.map((r) => r.url)).toEqual([
      'https://telegram.me/WantToPayBot?start=w17851188--XYBXD',
      'https://claude.ai/referral/PzwnMtcV4A?s=android',
      'https://manus.im/invitation/ZPITNRPMOEFT?utm_source=invitation&utm_medium=social&utm_campaign=system_share',
    ]);
  });

  it('подвал — валидный Telegram HTML, & экранирован, без эмодзи', () => {
    const footer = aiChannelFooter();
    expect(telegramHtmlIssue(footer)).toBeNull();
    expect(footer).toContain('utm_source=invitation&amp;utm_medium=social&amp;utm_campaign=system_share');
    expect(footer).not.toMatch(/\p{Extended_Pictographic}/u);
    // Одна строка (решение владельца 26.09): три строки читались рекламой.
    expect(footer.split('\n')).toHaveLength(1);
    expect(footer.match(/<a href=/g)).toHaveLength(3);
    expect(footer.replace(/<[^>]+>/g, '')).toBe('Карта для оплаты AI · Claude Pro на неделю · Manus');
  });

  it('длинная подпись к фото: ужимается тело, подвал цел и влезает в 1024', () => {
    const body = `<b>Заголовок</b>\n${'Длинный абзац про модель. '.repeat(80)}`;
    const out = withAiChannelFooter(body, TELEGRAM_CAPTION_LIMIT, repairTelegramHtml);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(out.endsWith(aiChannelFooter())).toBe(true);
    expect(telegramHtmlIssue(out)).toBeNull();
    // Общий срез отправителя подпись больше не тронет — и подвал не потеряется.
    expect(repairTelegramHtml(out, TELEGRAM_CAPTION_LIMIT)).toBe(out);
  });

  it('короткий пост не ужимается', () => {
    const body = '<b>Коротко</b>\nОдин факт.';
    expect(withAiChannelFooter(body, TELEGRAM_TEXT_LIMIT, repairTelegramHtml)).toBe(`${body}\n\n${aiChannelFooter()}`);
  });
});

describe('подключено в обе публикации AI-канала, после фактчека', () => {
  it('дайджест: подвал после судьи, полировка перед отправкой владельцу', () => {
    const src = read('lib/agents/scout-digest.ts');
    const judge = src.lastIndexOf('judgeClaims(aiDigest');
    const footer = src.indexOf('withAiChannelFooter(aiDigest');
    const send = src.indexOf('tgSendRich(aiChannelId, aiPost');
    expect(judge).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(judge);
    expect(send).toBeGreaterThan(footer);
    expect(src.indexOf('polishDigest(digest)')).toBeLessThan(src.indexOf('tgSend(digest,'));
    // Отрезанное не глушится — уезжает в отчёт прогона.
    expect(src).toMatch(/tail_dropped: tailDropped/);
    expect(read('lib/agents/scout-digest-run.ts')).toMatch(/tail_dropped: result\.tail_dropped/);
  });

  it('новость: подвал после текстовых ворот, прямо перед отправкой', () => {
    const src = read('lib/notifications/telegram-channel.ts');
    const gate = src.indexOf('validateTextPost(postText)');
    const footer = src.indexOf('withAiChannelFooter(ruThousands(postText), TELEGRAM_CAPTION_LIMIT');
    const send = src.indexOf('tgPostPhoto(channelId, cover.url, postText)');
    expect(gate).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(gate);
    expect(send).toBeGreaterThan(footer);
  });
});
