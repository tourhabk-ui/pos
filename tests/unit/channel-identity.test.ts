/**
 * tests/unit/channel-identity.test.ts
 *
 * Опознание канала: содержимое показывается человеку, вердикта в коде нет.
 *
 * Подбор источников нашёл живой `t.me/s/kammeteo` и предположил, что это
 * Камчатское УГМС. Перепись доказала, что канал жив, — и ровно ничего про то,
 * ЧЕЙ он. Лавинный бюллетень «неизвестно от кого» в источниках безопасности
 * хуже, чем отсутствие источника: турист поверит подписи, а не нашей
 * осторожности.
 *
 * Первая редакция звала сюда модель. Прогон 1 показал, что звать некого:
 * ответил заголовок страницы — «Александр Колесов. О погоде в Петербурге», —
 * а модель в это время отвечала HTTP 402. Утверждение «канал принадлежит
 * такой-то службе» машиной не проверяется, а место, где модель нельзя
 * проверить, — не её место.
 */
import { describe, it, expect } from 'vitest';
import { parseChannel } from '../../scripts/channel-identity-runner';

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

describe('опознание отвечает содержимым, а не выводом', () => {
  it('заголовок и описание доносятся до человека целиком', () => {
    // Ровно эта строка ответила на вопрос «чей kammeteo» 08.09: «Александр
    // Колесов. О погоде в Петербурге». Модель в это время отвечала 402 и не
    // сказала ничего; вывод владельца — «астра бесполезна» — и относится к
    // ней как к источнику утверждений. Проверять «канал принадлежит такой-то
    // службе» машиной нечем, поэтому вердикта в коде нет вовсе: показываем
    // текст, решает человек.
    const c = parseChannel(`
      <div class="tgme_channel_info_header_title">Александр Колесов. О погоде в Петербурге.</div>
      <div class="tgme_channel_info_description">Официальный прогноз по Санкт-Петербургу</div>
      <div class="tgme_widget_message">
        <div class="tgme_widget_message_text">Циклоны идут через наш регион один за другим.</div>
        <time datetime="2026-09-07T07:14:59+00:00"></time>
      </div>`);
    expect(c.title).toContain('Петербург');
    expect(c.description).toContain('Санкт-Петербург');
    expect(c.posts[0]).toContain('Циклоны');
  });

  it('имя канала ничего не обещает: разбор не выводит регион из адреса', () => {
    // kammeteo звучит как «камчатская метеослужба» и ею не является.
    const c = parseChannel('<div class="tgme_channel_info_header_title">Погода СПб</div>');
    expect(c.title).toBe('Погода СПб');
  });
});
