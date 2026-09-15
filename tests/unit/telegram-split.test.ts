/**
 * Сторож разбивки длинного выпуска на части.
 *
 * Владелец прислал дайджест 15.09, оборванный на полуслове: «Go-харнесс,
 * превращающий любой сай». Так и работало: текст резался под потолок Bot API,
 * ставилось «…», второго сообщения не было — хвост выпуска не доходил ВОВСЕ,
 * а прогон при этом писался `success` и `digest_sent: true`.
 *
 * Держит четыре вещи, которыми разбивка может соврать:
 *   — потерять текст молча;
 *   — отдать часть, которую Bot API не примет (разорванный тег);
 *   — переоткрыть тег, потеряв его атрибуты (`<a href>` перестаёт быть
 *     ссылкой, `<blockquote expandable>` — сворачиваться);
 *   — записать успех, когда ушла только первая часть.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  splitTelegramHtmlReport, telegramHtmlIssue, TELEGRAM_MAX_PARTS,
} from '@/lib/notifications/telegram-html';

const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ');

describe('разбивка выпуска на сообщения', () => {
  it('короткий текст остаётся ОДНИМ сообщением и не получает подписи частей', () => {
    const r = splitTelegramHtmlReport('<b>Дайджест</b>\nкороткий', 4000);
    expect(r.parts).toHaveLength(1);
    expect(r.droppedChars).toBe(0);
    expect(r.parts[0]).toBe('<b>Дайджест</b>\nкороткий');
  });

  it('длинный текст доходит ЦЕЛИКОМ, а не обрывается на потолке', () => {
    const src = words(3000);
    // Потолок частей поднят намеренно: здесь проверяется САМА разбивка —
    // что текст переживает её целиком. Поведение на упёршемся потолке —
    // отдельная проверка ниже, и смешивать их значит не проверить ни то,
    // ни другое.
    const r = splitTelegramHtmlReport(src, 500, 100);
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.droppedChars).toBe(0);

    // Склеенные части содержат все слова исходника — ни одно не пропало.
    const joined = r.parts.join(' ');
    for (const w of ['слово0', 'слово1500', 'слово2999']) {
      expect(joined, `потеряно ${w}`).toContain(w);
    }
  });

  it('каждая часть влезает в потолок и принимается разборщиком Bot API', () => {
    const src = `<blockquote>${words(400)}</blockquote>\n<b>${words(400)}</b>`;
    const r = splitTelegramHtmlReport(src, 400);
    expect(r.parts.length).toBeGreaterThan(1);
    for (const p of r.parts) {
      expect(p.length).toBeLessThanOrEqual(400);
      // Разорванный на срезе тег — это `Bot API 400: can't parse entities`,
      // то есть не усечение, а неотправленное сообщение.
      expect(telegramHtmlIssue(p), `негодная разметка: ${p.slice(0, 80)}`).toBeNull();
    }
  });

  it('тег переоткрывается ЦЕЛИКОМ, с атрибутами', () => {
    // `<a href>`, переоткрытый как `<a>`, перестаёт быть ссылкой — часть
    // выпуска молча теряет адрес материала.
    const src = `<a href="https://example.com/very/long/path">${words(300)}</a>`;
    const r = splitTelegramHtmlReport(src, 400);
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.parts[1]).toContain('<a href="https://example.com/very/long/path">');
  });

  it('текст длиннее потолка частей — остаток ОБЪЯВЛЯЕТСЯ числом, а не гасится', () => {
    const r = splitTelegramHtmlReport(words(20000), 300, 2);
    expect(r.parts).toHaveLength(2);
    // «Не поместилось» обязано быть состоянием, а не тишиной (§4.0).
    expect(r.droppedChars).toBeGreaterThan(0);
    expect(r.parts[1]).toContain('…');
  });

  it('потолок частей задан и разумен — двадцать сообщений подряд это флуд, а не доставка', () => {
    expect(TELEGRAM_MAX_PARTS).toBeGreaterThan(1);
    expect(TELEGRAM_MAX_PARTS).toBeLessThanOrEqual(10);
  });
});

describe('дайджест отправляет ВСЕ части', () => {
  const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf8');
  // Объяснения снимаются: разбор дефекта в шапке ЦИТИРУЕТ прежний вызов
  // `repairTelegramHtml(text, 4000)`, и поиск по коду попадал бы в рассказ о
  // том, как было, вместо того, как стало.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const sender = code.slice(code.indexOf('async function tgSendTo'), code.indexOf('async function tgSendRich'));
  const aiSender = code.slice(code.indexOf('async function tgSendRich'), code.indexOf('async function tgSend(text'));

  it('отправитель разбивает, а не режет', () => {
    expect(sender).toContain('splitTelegramHtmlReport');
    // Обрезка под потолок в отправителе выпуска — это ровно тот дефект,
    // который здесь чинится.
    expect(sender).not.toMatch(/repairTelegramHtml\(text/);
  });

  it('успех — это все части: отправка останавливается на первой неудаче', () => {
    // Выпуск, дошедший наполовину, не доставлен. Записать его успехом значило
    // бы вернуть прежнюю немоту, только в журнал.
    expect(sender).toMatch(/if \(!ok\) return false;/);
  });

  it('части нумеруются, а одиночное сообщение — нет', () => {
    expect(sender).toMatch(/parts\.length > 1/);
    expect(sender).toContain('parts.length}</i>');
  });

  it('недосланный остаток попадает в причину, а не остаётся в тишине', () => {
    expect(sender).toMatch(/droppedChars > 0/);
    expect(sender).toContain('знаков не отправлено');
  });

  it('пост в ИИ-канал тоже разбивается, а не режется', () => {
    // Второй отправитель резал ровно так же. Сорок тысяч подписчиков делают
    // тихую потерю дороже, а не дешевле.
    expect(aiSender).toContain('splitTelegramHtmlReport');
    expect(aiSender).not.toMatch(/repairTelegramHtml\(text/);
  });

  it('обложка над первой частью, кнопки под последней', () => {
    // Обложка над каждой частью превратила бы один пост в ленту картинок;
    // кнопки посреди поста читаются как его конец.
    expect(aiSender).toMatch(/coverUrl && first/);
    expect(aiSender).toMatch(/buttons\?\.length && last/);
  });
});
