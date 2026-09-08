/**
 * tests/unit/kuzmich-feed-outcome.test.ts
 *
 * Отказ лент отличим от «тревог нет» — и не стоит туристу 28 секунд.
 *
 * ── Что уже сделано в main (#1722) ─────────────────────────────────────────
 *
 * `fetchMchsAlerts` и `fetchKamchatkaNews` получили три исхода вместо двух
 * (`ok` / `empty` / `no_feeds`), отказ каждой ленты уходит в лог, а раздел МЧС
 * при `no_feeds` не исчезает из промпта, а говорит вслух, что сводки не видно.
 * Правка верная; сторожа у неё не было — этот файл его добавляет.
 *
 * ── Что добавлено сверх ────────────────────────────────────────────────────
 *
 * Короткая память об отказе. Кэш держал только удачу, а неудача не держалась
 * вовсе — и на КАЖДОЕ сообщение туриста мы заново стучались в мёртвые ленты:
 * два таймаута по 8 секунд у новостей плюс два по 6 у МЧС, до 28 секунд перед
 * ответом. Ленты МЧС с прода могут быть гео-закрыты, то есть это не редкий
 * край, а состояние по умолчанию.
 *
 * Пять минут выбраны намеренно малыми: долгая память об отказе была бы ХУЖЕ
 * её отсутствия — ожившая лента не доехала бы до человека целый час, и
 * настоящее предупреждение МЧС опоздало бы ровно на столько же. Сторож держит
 * обе границы: что память есть и что она короткая.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');

describe('три исхода чтения ленты (#1722)', () => {
  it('тип различает «пусто» и «никто не ответил»', () => {
    expect(SRC).toMatch(/\|\s*\{ state: 'empty' \}/);
    expect(SRC).toMatch(/\|\s*\{ state: 'no_feeds'; tried: number \}/);
  });

  it('«никто не ответил» ставится только когда answered === 0', () => {
    // Граница смысла: одна ответившая лента делает тишину законной.
    const hits = SRC.match(/answered === 0 \? \{ state: 'no_feeds'/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('отказ каждой ленты попадает в лог с её адресом', () => {
    expect(SRC).toMatch(/logSwallowed\(`лента МЧС \$\{url\}`/);
    expect(SRC).toMatch(/logSwallowed\(`лента новостей \$\{url\}`/);
  });

  it('HTTP-отказ логируется, а не молча пропускается через continue', () => {
    // `if (!res.ok) continue;` и делал отказ неотличимым от пустой ленты.
    expect(SRC).toMatch(/if \(!res\.ok\) \{\s*\n\s*logSwallowed/);
  });
});

describe('раздел МЧС не исчезает молча', () => {
  it('при no_feeds в промпт уходит прямая оговорка', () => {
    expect(SRC).toMatch(/mchs\.state === 'no_feeds'/);
    expect(SRC).toMatch(/СВОДКА НЕДОСТУПНА/);
    expect(SRC).toMatch(/Это НЕ значит «предупреждений нет»/);
  });

  it('у новостей такой оговорки нет — и это осознанно', () => {
    // Новости туристу ничего не обещают; строка «новостей не видно» в каждом
    // ответе была бы шумом. Обещает только раздел безопасности.
    const block = SRC.slice(SRC.indexOf('НОВОСТИ КАМЧАТКИ'), SRC.indexOf('РАЗВЕДКА ИЗ TG-ГРУПП'));
    expect(block).not.toMatch(/НЕДОСТУПН/);
  });
});

describe('память об отказе: есть и короткая', () => {
  it('отказ помнится — иначе каждое сообщение ждёт таймауты заново', () => {
    expect(SRC).toMatch(/const failed = recentFailure\(_mchsFail\);\s*\n\s*if \(failed\) return failed;/);
    expect(SRC).toMatch(/const failed = recentFailure\(_newsFail\);\s*\n\s*if \(failed\) return failed;/);
  });

  it('пять минут, а не час удачного кэша', () => {
    // Ключевая граница: долгая память об отказе задержала бы настоящее
    // предупреждение МЧС ровно на свой срок.
    expect(SRC).toMatch(/const FEED_FAIL_TTL = 5 \* 60 \* 1000/);
    expect(SRC).toMatch(/const NEWS_TTL = 60 \* 60 \* 1000/);
  });

  it('удача в память об отказе не кладётся', () => {
    // Иначе успех вытеснил бы себя же через пять минут.
    const fn = SRC.slice(SRC.indexOf('function rememberFailure'), SRC.indexOf('/** Fetch Kamchatka news'));
    expect(fn).not.toMatch(/state: 'ok'/);
  });

  it('срок истёк — идём в сеть, а не отдаём старый отказ вечно', () => {
    expect(SRC).toMatch(/Date\.now\(\) - memo\.at < FEED_FAIL_TTL \? memo\.outcome : null/);
  });
});
