/**
 * У постов Кузьмича должна быть картинка — и настоящая.
 *
 * Наблюдение владельца 25.07.2026: в ленте соседний канал идёт со снимком, а
 * совет Кузьмича — голым текстом. Причина оказалась не в отсутствии
 * возможности: фото-путь (tgPostPhoto, снимки в public/images, карты
 * LOCATION_PHOTO/ACTIVITY_PHOTO) работал у постов о МЕСТАХ, а postKuzmichTip
 * звал postToAllChannels без photoUrl.
 *
 * Тест держит два условия, которые легко нарушить незаметно:
 *  1. у каждой темы совета есть картинка;
 *  2. картинка — реальный файл в репозитории, а не выдуманный путь. Битая
 *     ссылка в Telegram молча превращает пост обратно в текстовый (так уже
 *     было с «Большим Калыгирем»), то есть поломка была бы невидимой.
 *
 * Генерация картинок сюда не допускается сознательно: решение 2026-07-17 —
 * AI-пейзажи не показываем. Честный снимок наших термов лучше нарисованного.
 */
import { describe, it, expect } from 'vitest';
import { KUZMICH_TIP_TOPIC_LIST } from '@/lib/notifications/telegram-channel';
import { familiarVoiceIssue } from '@/lib/notifications/post-validation';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

describe('советы Кузьмича идут с настоящим фото', () => {
  it('темы вообще есть', () => {
    expect(KUZMICH_TIP_TOPIC_LIST.length).toBeGreaterThan(0);
  });

  it('у каждой темы задана картинка из public/images', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      expect(t.photo, `тема «${t.topic}» без фото`).toBeTruthy();
      expect(t.photo.startsWith('/images/'), `тема «${t.topic}»: фото не из public/images`).toBe(true);
    }
  });

  it('каждый файл существует в репозитории', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      const path = join(process.cwd(), 'public', t.photo);
      expect(existsSync(path), `нет файла ${t.photo} (тема «${t.topic}»)`).toBe(true);
    }
  });

  it('никаких внешних и сгенерированных картинок', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      expect(/^https?:\/\//.test(t.photo), `тема «${t.topic}»: внешняя ссылка`).toBe(false);
      expect(/pollinations|unsplash|placeholder|generated/i.test(t.photo)).toBe(false);
    }
  });

  it('темы не дублируются', () => {
    const topics = KUZMICH_TIP_TOPIC_LIST.map((t) => t.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });
});

/**
 * Текст пишется к снимку, а не вслепую (26.09): совет «я бы выбрал сентябрь,
 * ягода на сопках спелая» ушёл под снимком снегоходов на заснеженном берегу.
 * Тема «не в август, а в другое время» разрешала модели любой сезон, а снимок
 * был прибит к зиме; что на снимке, модель не знала.
 */
describe('текст совета не спорит со снимком', () => {
  const SEASONS: Array<[RegExp, RegExp]> = [
    [/зим/i, /зим|снег/i],
    [/лет[оа]|летом|август|июл/i, /лет|зелён/i],
    [/осен|сентябр|октябр/i, /осен|сентябр|октябр/i],
    [/весн|апрел|ма[йя]/i, /весн/i],
  ];

  it('у каждой темы описано, что на снимке', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      expect(t.photoShows?.trim().length ?? 0, `тема «${t.topic}» без описания снимка`).toBeGreaterThan(20);
    }
  });

  it('сезон, названный в теме, совпадает с сезоном снимка', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      // «не в августе» — отрицание, сезон темы задаёт утвердительная часть.
      const asserted = t.topic.replace(/не\s+в\s+[а-яё]+/gi, '');
      for (const [inTopic, inPhoto] of SEASONS) {
        if (inTopic.test(asserted)) {
          expect(inPhoto.test(t.photoShows), `тема «${t.topic}» про сезон, которого нет на снимке: ${t.photoShows}`).toBe(true);
        }
      }
    }
  });

  it('тема о выборе времени не прибита к снимку одного сезона', () => {
    // Сам случай 26.09: «не в август, а в другое время» разрешает модели ЛЮБОЙ
    // сезон, а снимок — зима. Такой теме нужен снимок без сезона либо тема,
    // сама называющая сезон снимка.
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      if (!/время|когда|сезон/i.test(t.topic)) continue;
      const neutral = /сезон по снимку не определить/.test(t.photoShows);
      const asserted = t.topic.replace(/не\s+в\s+[а-яё]+/gi, '');
      const named = SEASONS.some(([inTopic, inPhoto]) => inTopic.test(asserted) && inPhoto.test(t.photoShows));
      expect(neutral || named, `тема «${t.topic}» выбирает время, а снимок одного сезона: ${t.photoShows}`).toBe(true);
    }
  });

  it('описание снимка уходит в промпт вместе с запретом противоречить', () => {
    const src = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');
    const tip = src.slice(src.indexOf('export async function postKuzmichTip'));
    const body = tip.slice(0, tip.indexOf('\n}\n'));
    expect(body).toMatch(/К посту приложен снимок: \$\{picked\.photoShows\}/);
    expect(body).toMatch(/не должен ему противоречить/);
  });
});

describe('голос Кузьмича держит код, а не промпт', () => {
  it('ловит пост, ушедший в канал 26.09', () => {
    expect(familiarVoiceIssue('Народ зачем-то ломится на Камчатку в августе, а потом стоит в очереди')).not.toBeNull();
    expect(familiarVoiceIssue('<b>Свет</b> уже низкий. Народ, не спешите в август.')).not.toBeNull();
    expect(familiarVoiceIssue('Слушай, братва, собирайтесь')).not.toBeNull();
  });

  it('не трогает законное слово', () => {
    expect(familiarVoiceIssue('Коренные народы Камчатки встречают осень праздником.')).toBeNull();
    expect(familiarVoiceIssue('Ительмены — народ, который знает эту землю.')).toBeNull();
    expect(familiarVoiceIssue('Я бы выбрал сентябрь: свет низкий, вулканы объёмные.')).toBeNull();
  });

  it('совет не публикуется с панибратством: проверка стоит до отправки', () => {
    const src = readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf-8');
    const tip = src.slice(src.indexOf('export async function postKuzmichTip'));
    const check = tip.indexOf('familiarVoiceIssue(text)');
    const send = tip.indexOf('postToAllChannels(');
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
    expect(tip.slice(check, send)).toMatch(/return \{ ok: false/);
  });
});

