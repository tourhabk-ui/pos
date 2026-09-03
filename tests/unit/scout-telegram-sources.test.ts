// @vitest-environment node
/**
 * Telegram-каналы в разведке (03.09, слово владельца: «добавь в разведку»).
 *
 * Сторож держит: читается только публичное превью t.me/s/<канал>;
 * ссылка-приглашение (закрытый чат) в источники не попадает; разбор даёт
 * заголовок и постоянную ссылку на пост; источник рода telegram идёт своим
 * разборщиком, а не RSS; у каждого нового источника есть порог тишины.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTelegramPreview, isTelegramInvite, telegramPreviewUrl } from '@/lib/agents/scout-telegram';
import { RSS_SOURCES } from '@/lib/agents/scout-digest';
import { SCOUT_SOURCE_EXPECTATIONS } from '@/lib/services/scout/source-health';

const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
const TOML = readFileSync(join(process.cwd(), 'infra/safety-relay/wrangler.toml'), 'utf-8');

const SAMPLE = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="ru_rst/1234">
    <div class="tgme_widget_message_text js-message_text" dir="auto">Минэкономразвития утвердило правила субсидий <b>на модульные отели</b><br/>Подробности в документе.</div>
    <a class="tgme_widget_message_date" href="https://t.me/ru_rst/1234"><time datetime="2026-09-03T10:00:00+00:00">10:00</time></a>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="ru_rst/1235">
    <div class="tgme_widget_message_text js-message_text" dir="auto">ok</div>
    <a class="tgme_widget_message_date" href="https://t.me/ru_rst/1235"></a>
  </div>
</div>`;

describe('разбор превью', () => {
  it('пост → первая строка и постоянная ссылка; короткий пост не сигнал', () => {
    const posts = parseTelegramPreview(SAMPLE, 'РСТ (Telegram)');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      title: 'Минэкономразвития утвердило правила субсидий на модульные отели',
      url: 'https://t.me/ru_rst/1234',
      source: 'РСТ (Telegram)',
    });
  });

  it('длинный пост обрезается, не выбрасывается', () => {
    const long = SAMPLE.replace('Минэкономразвития утвердило правила субсидий <b>на модульные отели</b>', 'слово '.repeat(60));
    const [p] = parseTelegramPreview(long, 'x');
    expect(p!.title.length).toBeLessThanOrEqual(140);
    expect(p!.title.endsWith('…')).toBe(true);
  });

  it('только публичное превью: адрес строится на t.me/s/, приглашения распознаются', () => {
    expect(telegramPreviewUrl('@ru_rst')).toBe('https://t.me/s/ru_rst');
    expect(isTelegramInvite('https://t.me/+ll3pbl442dNkZmYy')).toBe(true);
    expect(isTelegramInvite('https://t.me/joinchat/abc')).toBe(true);
    expect(isTelegramInvite('https://t.me/s/ru_rst')).toBe(false);
  });
});

describe('источники разведчика', () => {
  const tg = RSS_SOURCES.filter(s => s.kind === 'telegram');

  it('три канала владельца внесены как публичные превью', () => {
    expect(tg.map(s => s.url).sort()).toEqual([
      'https://t.me/s/minec_tourism',
      'https://t.me/s/ru_rst',
      'https://t.me/s/vibecoding_tg',
    ]);
  });

  it('ссылка-приглашение в источниках отсутствует', () => {
    expect(RSS_SOURCES.some(s => isTelegramInvite(s.url))).toBe(false);
  });

  it('у каждого нового источника есть порог тишины', () => {
    const keys = new Set(SCOUT_SOURCE_EXPECTATIONS.map(e => e.key));
    for (const s of tg) expect(keys.has(s.key), s.key).toBe(true);
  });

  it('род telegram идёт своим разборщиком на обоих путях, t.me в белом списке реле', () => {
    expect(DIGEST).toMatch(/s\.kind === 'telegram'\s*\?\s*parseTelegramPreview\(text, s\.label\)/);
    expect(DIGEST).toMatch(/const items = parse\(relayed\.text\)/);
    expect(TOML).toMatch(/RELAY_HOSTS = "[^"]*\bt\.me\b/);
    expect(TOML).toMatch(/rostourunion\.ru/);
  });
});
