/**
 * Сторож третьего состояния у снимка (07.09).
 *
 * Отправка возвращала `ok: true` и когда снимок ушёл, и когда снимок отвергли,
 * а текст ушёл. Одно слово на два разных события — и «ни одной фотографии»
 * прожило незамеченным: крон отвечал успехом, прогоны в Actions были зелёные,
 * а увидеть разницу мог только человек, открывший канал.
 *
 * Это ровно §4.0 на нашем же коде: место, где нельзя сказать «снимок не ушёл»,
 * заполнялось словом «успех».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const CHANNEL = strip(readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf8'));
const CRON = strip(readFileSync(join(process.cwd(), 'app/api/cron/kuzmich/route.ts'), 'utf8'));

describe('у снимка три исхода, а не два', () => {
  it('исходы названы поимённо', () => {
    expect(CHANNEL).toMatch(/type PhotoOutcome = 'sent' \| 'text_only' \| 'none'/);
  });

  it('«снимка не просили» отделено от «снимок не ушёл»', () => {
    expect(CHANNEL).toMatch(/const asked = Boolean\(/);
    expect(CHANNEL).toMatch(/!asked \? 'none'/);
  });

  it('откат в текст считается НЕ отправкой снимка, хотя пост ушёл', () => {
    expect(CHANNEL).toMatch(/fellBackToText/);
    expect(CHANNEL).toMatch(/mainResult\.ok && !fellBack \? 'sent' : 'text_only'/);
  });

  it('отказ публикации не выдаёт снимок за отправленный', () => {
    // Оба ранних выхода (запрещённый текст, провал валидации) обязаны нести
    // исход снимка, иначе поле осталось бы неопределённым именно там, где
    // разбираются с отказом.
    const early = CHANNEL.match(/return \{ ok: false, error, photo: 'none' \}/g) ?? [];
    expect(early.length).toBeGreaterThanOrEqual(2);
  });
});

describe('исход снимка виден снаружи', () => {
  it('крон отдаёт его в ответе', () => {
    expect(CRON).toMatch(/photo: result\.photo \?\? 'unknown'/);
    expect(CRON).toMatch(/photo_error: result\.photoError \?\? null/);
  });

  it('журнал поста хранит его же', () => {
    expect(CHANNEL).toMatch(/'kuzmich_post'[\s\S]{0,200}photo: result\.photo/);
    expect(CHANNEL).toMatch(/'kuzmich_tour_post'[\s\S]{0,240}photo: result\.photo/);
  });
});
