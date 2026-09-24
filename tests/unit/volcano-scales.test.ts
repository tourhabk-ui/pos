// @vitest-environment node
/**
 * Вулкан на радаре по двум шкалам — KVERT и КФ ЕГС.
 *
 * Решение владельца 24.09: «да, показывай обе шкалы на радаре». Повод: 22.09
 * Мутновский и Горелый стояли жёлтыми по шкале КФ ЕГС (сейсмичность выше
 * фона, 255 и 221 событие), KVERT держал их зелёными, и радар знал только
 * KVERT — вулканов у туристских троп на круге не было.
 *
 * Шкалы разные (у KVERT — авиационный код про пепел, у КФ ЕГС — сейсмичность,
 * газ, термоаномалии), поэтому здесь держится: ни одна не побеждает, метка
 * ставится по любой повышенной, в подписи — обе, «Белый» метку не ставит и в
 * зелёный не превращается, устаревшая сводка текущей не считается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  volcanoMarks,
  levelForColor,
  kfegsIsFresh,
  type KfegsReading,
} from '@/lib/services/safety/volcano-scales';

const PLACES = new Map([
  ['mut', { name: 'Мутновский', lat: 52.45, lng: 158.2 }],
  ['gor', { name: 'Горелый', lat: 52.56, lng: 158.03 }],
  ['she', { name: 'Шивелуч', lat: 56.65, lng: 161.36 }],
  ['kar', { name: 'Карымский', lat: 54.05, lng: 159.44 }],
  ['kor', { name: 'Корякский', lat: 53.32, lng: 158.71 }],
]);

const reading = (color: KfegsReading['color'], raw: string, seismicity: string | null = null): KfegsReading =>
  ({ color, raw, seismicity, date: '2026-09-22' });

describe('метка ставится, если вулкан повышен хотя бы по одной шкале', () => {
  it('жёлтый у КФ ЕГС при зелёном KVERT — метка есть (случай 22.09)', () => {
    const marks = volcanoMarks(
      new Map([['mut', 'green']]),
      new Map([['mut', reading('yellow', 'Желтый', 'R=3.2; Ks пред.=4.0 Выше фона. Количество событий в районе вулкана 255.')]]),
      PLACES,
    );
    expect(marks.map((m) => m.label)).toEqual(['Мутновский']);
    expect(marks[0].level).toBe('danger');
  });

  it('оранжевый KVERT без сводки КФ ЕГС — метка есть', () => {
    const marks = volcanoMarks(new Map([['she', 'orange']]), new Map(), PLACES);
    expect(marks[0].label).toBe('Шивелуч');
    expect(marks[0].level).toBe('critical');
  });

  it('зелёный по обеим — метки нет', () => {
    const marks = volcanoMarks(new Map([['kor', 'green']]), new Map([['kor', reading('green', 'Зеленый')]]), PLACES);
    expect(marks).toEqual([]);
  });

  it('уровень — по более высокой из двух', () => {
    const marks = volcanoMarks(new Map([['she', 'yellow']]), new Map([['she', reading('orange', 'Оранжевый')]]), PLACES);
    expect(marks[0].level).toBe('critical');
  });
});

describe('в подписи — обе шкалы, каждая названа', () => {
  const [m] = volcanoMarks(
    new Map([['mut', 'green']]),
    new Map([['mut', reading('yellow', 'Желтый', 'R=3.2; Ks пред.=4.0 Выше фона. Количество событий в районе вулкана 255.')]]),
    PLACES,
  );

  it('КФ ЕГС — со своим смыслом, датой сводки и причиной цвета', () => {
    expect(m.note).toContain('КФ ЕГС (сейсмичность, за 22.09): жёлтый');
    expect(m.note).toContain('255');
    // Служебное «R=…; Ks пред.=…» туристу ни о чём не говорит.
    expect(m.note).not.toMatch(/Ks пред/);
  });

  it('KVERT — со своим смыслом, даже когда он зелёный', () => {
    // Зелёный KVERT рядом с жёлтым КФ ЕГС — не противоречие, а другая шкала,
    // и человек должен видеть обе, чтобы не решить, что одна из них ошиблась.
    expect(m.note).toContain('KVERT (авиация): зелёный');
  });

  it('нет сводки КФ ЕГС — так и сказано, а не пропущено', () => {
    const [x] = volcanoMarks(new Map([['she', 'orange']]), new Map(), PLACES);
    expect(x.note).toContain('КФ ЕГС: свежей сводки нет');
  });
});

describe('«Белый» — не опасность и не зелёный', () => {
  it('белый при зелёном KVERT метки не ставит', () => {
    // «Мониторинг невозможен» — это не повышенная активность.
    expect(volcanoMarks(new Map([['kar', 'green']]), new Map([['kar', reading(null, 'Белый')]]), PLACES)).toEqual([]);
  });

  it('белый при повышенном KVERT — метка по KVERT, а белый назван словами', () => {
    const [x] = volcanoMarks(new Map([['kar', 'orange']]), new Map([['kar', reading(null, 'Белый')]]), PLACES);
    expect(x.level).toBe('critical');
    expect(x.note).toContain('код «Белый» — значение неизвестно');
    expect(x.note).not.toMatch(/КФ ЕГС[^·]*зелёный/);
  });

  it('уровня у неразобранного кода нет', () => {
    expect(levelForColor(null)).toBeNull();
    expect(levelForColor('green')).toBeNull();
  });
});

describe('устаревшая сводка текущей не считается', () => {
  it('сводка за 22.09 свежа до начала 25.09 UTC', () => {
    expect(kfegsIsFresh('2026-09-22', Date.parse('2026-09-24T01:00:00Z'))).toBe(true);
    expect(kfegsIsFresh('2026-09-22', Date.parse('2026-09-24T23:59:00Z'))).toBe(true);
    expect(kfegsIsFresh('2026-09-22', Date.parse('2026-09-25T00:30:00Z'))).toBe(false);
  });

  it('сводки нет вовсе — не свежая', () => {
    expect(kfegsIsFresh(null)).toBe(false);
    expect(kfegsIsFresh('не дата')).toBe(false);
  });
});

it('вулкан без места в каталоге метку не получает — ставить её некуда', () => {
  expect(volcanoMarks(new Map([['nowhere', 'red']]), new Map(), PLACES)).toEqual([]);
});

describe('радар читает обе шкалы, и ни одна не гасит другую', () => {
  const DATA = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');

  it('сборка меток — общей функцией, а не своей копией', () => {
    expect(DATA).toContain('volcanoMarks(kvert, kfegs, places)');
  });

  it('отказ второй шкалы — degraded, а не молчание', () => {
    const at = DATA.indexOf('FROM volcano_bulletin_kfegs');
    expect(at).toBeGreaterThan(0);
    const around = DATA.slice(Math.max(0, at - 2500), at + 2500);
    expect(around).toMatch(/kfegsIsFresh\(d\)\)\s*\{\s*degraded = true/);
    expect(around).toMatch(/сводка КФ ЕГС не выбралась[\s\S]{0,80}degraded = true/);
  });

  it('volcano_status (KVERT) шкалой КФ ЕГС не перезаписывается', () => {
    const sync = readFileSync(join(process.cwd(), 'lib/services/safety/emsd-vmon-sync.ts'), 'utf-8');
    const code = sync.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/volcano_status/);
    expect(code).toContain('INSERT INTO volcano_bulletin_kfegs');
  });

  it('пушей и событий ленты сводка не производит', () => {
    const sync = readFileSync(join(process.cwd(), 'lib/services/safety/emsd-vmon-sync.ts'), 'utf-8');
    const code = sync.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // Не голое «push»: оно есть в array.push(). Ищутся настоящие пути —
    // запись в ленту и отправка уведомлений.
    expect(code).not.toMatch(/external_alerts|saveEvent|saveQuakeOnce|dispatchPushAlerts|sendPush|web-push/);
  });
});
