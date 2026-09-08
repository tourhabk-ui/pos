/**
 * tests/unit/channel-identity.test.ts
 *
 * Опознание канала: модель судит по скачанному, а не по памяти.
 *
 * Подбор источников нашёл живой `t.me/s/kammeteo` и предположил, что это
 * Камчатское УГМС. Перепись доказала, что канал жив, — и ровно ничего про то,
 * ЧЕЙ он. Лавинный бюллетень «неизвестно от кого» в источниках безопасности
 * хуже, чем отсутствие источника: турист поверит подписи, а не нашей
 * осторожности.
 *
 * Спрашивать модель по памяти про малоизвестный региональный канал —
 * заказывать вымысел: она ответит уверенно и мимо. Поэтому вердикт принимается
 * ТОЛЬКО с уликой, которая дословно встречается в скачанном тексте.
 */
import { describe, it, expect } from 'vitest';
import { parseChannel, evidenceHolds, type ChannelContent } from '../../scripts/channel-identity-runner';

const HTML = `
<div class="tgme_channel_info_header_title"><span>Камчатский Гидрометцентр</span></div>
<div class="tgme_channel_info_description">Оперативные предупреждения о погоде</div>
<div class="tgme_widget_message">
  <div class="tgme_widget_message_text js-message_text">Штормовое предупреждение: ожидается метель, видимость до 500 м.</div>
  <time datetime="2026-09-06T09:00:00+00:00"></time>
</div>
<div class="tgme_widget_message">
  <div class="tgme_widget_message_text js-message_text">Лавинная опасность в районе Авачинского перевала.</div>
  <time datetime="2026-09-07T05:30:00+00:00"></time>
</div>`;

describe('разбор превью канала', () => {
  const c = parseChannel(HTML);

  it('заголовок и описание снимаются со страницы, а не додумываются', () => {
    expect(c.title).toBe('Камчатский Гидрометцентр');
    expect(c.description).toBe('Оперативные предупреждения о погоде');
  });

  it('тексты постов очищены от разметки', () => {
    expect(c.posts).toHaveLength(2);
    expect(c.posts[1]).toBe('Лавинная опасность в районе Авачинского перевала.');
  });

  it('дата последнего поста — самая свежая из всех', () => {
    expect(c.lastPost).toBe('2026-09-07T05:30:00.000Z');
  });

  it('пустая страница не выдаётся за канал', () => {
    const empty = parseChannel('<html><body>ничего</body></html>');
    expect(empty.posts).toEqual([]);
    expect(empty.lastPost).toBeNull();
  });
});

describe('улика проверяется машиной, а не убедительностью', () => {
  const content: ChannelContent = parseChannel(HTML);

  it('дословная цитата из постов принимается', () => {
    expect(evidenceHolds({ evidence: 'Лавинная опасность в районе Авачинского перевала' }, content)).toBe(true);
  });

  it('цитата из заголовка принимается', () => {
    expect(evidenceHolds({ evidence: 'Камчатский Гидрометцентр' }, content)).toBe(true);
  });

  it('регистр и лишние пробелы не решают', () => {
    expect(evidenceHolds({ evidence: '  камчатский   ГИДРОМЕТЦЕНТР ' }, content)).toBe(true);
  });

  it('ПЕРЕСКАЗ своими словами не принимается — он неотличим от выдумки', () => {
    expect(evidenceHolds({ evidence: 'канал публикует прогнозы погоды по региону' }, content)).toBe(false);
  });

  it('выдуманная цитата не принимается', () => {
    expect(evidenceHolds({ evidence: 'Официальный канал ФГБУ Камчатское УГМС' }, content)).toBe(false);
  });

  it('пустая или крошечная улика не принимается', () => {
    // Иначе вердикт проходил бы с уликой вроде «да» — то есть без улики.
    expect(evidenceHolds({ evidence: '' }, content)).toBe(false);
    expect(evidenceHolds({ evidence: 'погода' }, content)).toBe(false);
    expect(evidenceHolds({}, content)).toBe(false);
  });
});
