/**
 * Счётчик видит поведение и не выдаёт человеко-дни за людей.
 *
 * Живой повод (28.07): владелец открыл «Посещаемость» и спросил — это правда?
 * Пользователей нет, а просмотры есть. Правда оказалась двойной: строки пишет
 * настоящий браузер, но ботов счётчик не отличал вообще, свой прежний домен
 * tourhab.ru показывал как внешний источник, а «уникальные за 30 дней» были
 * человеко-днями — суточный хэш содержит дату, и один человек за двадцать
 * заходов давал двадцать «уникальных».
 *
 * Тесты чистых функций — прямые; про схему и запросы — контрактные: они держат
 * связку миграция ↔ приём события ↔ витрина, чтобы поведение не отвалилось
 * молча при следующей правке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isBotUserAgent, isOwnReferrer } from '@/lib/analytics/bot-detect';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIGRATION = read('migrations/782_page_views_behavior.sql');
const HIT = read('app/api/analytics/hit/route.ts');
const DWELL = read('app/api/analytics/dwell/route.ts');
const TRACKER = read('components/shared/PageViewTracker.tsx');
const API = read('app/api/admin/analytics/traffic/route.ts');
const PAGE = read('app/hub/admin/traffic/page.tsx');

describe('опознание краулеров', () => {
  it('ловит поисковых, соцсетевых и AI-ботов', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; YandexBot/3.0)',
      'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
      'facebookexternalhit/1.1',
      'Mozilla/5.0 HeadlessChrome/126.0.0.0',
      'curl/8.4.0',
      'python-requests/2.32.0',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
  });

  it('живые браузеры не считает ботами', () => {
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 YaBrowser/24.6.0',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
  });

  it('клиент без User-Agent — не человек', () => {
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
  });
});

describe('свой домен — не источник перехода', () => {
  it('старое имя платформы тоже наше', () => {
    // Прямой повод: tourhab.ru висел в «источниках переходов» как внешний
    // приток, хотя это внутренняя навигация со старого домена.
    expect(isOwnReferrer('https://tourhab.ru/routes?kind=route')).toBe(true);
    expect(isOwnReferrer('https://vedarai.ru/routes')).toBe(true);
    expect(isOwnReferrer('http://localhost:3000/')).toBe(true);
  });

  it('чужие остаются источниками', () => {
    expect(isOwnReferrer('https://www.google.com/')).toBe(false);
    expect(isOwnReferrer('https://yandex.ru/')).toBe(false);
    expect(isOwnReferrer(null)).toBe(false);
  });
});

describe('схема и сбор поведения', () => {
  it('миграция заводит колонки визита, перехода, времени и меток', () => {
    for (const col of ['session_id', 'from_path', 'dwell_ms', 'is_bot', 'is_not_found']) {
      expect(MIGRATION).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    // Индексы под три реальных запроса витрины: порядок в визите, ребро, люди.
    expect(MIGRATION).toContain('idx_page_views_session');
    expect(MIGRATION).toContain('idx_page_views_edge');
    expect(MIGRATION).toContain('idx_page_views_human');
  });

  it('приём события пишет визит, предыдущий путь и метку бота', () => {
    expect(HIT).toContain('sessionId');
    expect(HIT).toContain('fromPath');
    expect(HIT).toContain('isBotUserAgent');
    // id нужен клиенту, чтобы дослать время на странице.
    expect(HIT).toContain('RETURNING id');
  });

  it('время на странице дописывается ровно один раз', () => {
    // Браузеры умеют слать pagehide и visibilitychange подряд: второй доклад
    // снят уже после ухода и затёр бы первый, честный.
    expect(DWELL).toContain('dwell_ms IS NULL');
    expect(TRACKER).toContain('sendBeacon');
    expect(TRACKER).toContain('visibilitychange');
  });
});

describe('витрина не врёт цифрой', () => {
  it('людские метрики считаются без ботов', () => {
    expect(API).toContain('is_bot = FALSE');
    // При этом боты не выброшены — их долю показываем отдельно.
    expect(API).toContain('month_bot_hits');
  });

  it('свои домены отсечены из источников, включая прежнее имя', () => {
    expect(API).toContain('tourhab\\\\.ru');
    expect(API).toContain('vedarai\\\\.ru');
  });

  it('за 30 дней это человеко-дни, а не люди', () => {
    expect(API).toContain('month_visitor_days');
    expect(PAGE).toContain('человеко-дней');
    // «Уникальные» остаются только там, где они правда уникальные, — за сутки.
    expect(PAGE).toContain('уникальных');
  });

  it('карта переходов и поведение страниц есть в ответе', () => {
    expect(API).toContain('from_path, path AS to_path');
    expect(API).toContain('percentile_cont(0.5)');
    expect(API).toContain('is_not_found');
    expect(PAGE).toContain('Карта переходов');
  });
});
