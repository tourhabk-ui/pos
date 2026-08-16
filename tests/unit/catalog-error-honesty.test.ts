/**
 * Публичная ошибка не ставит диагноз, а лог его доказывает.
 *
 * Ночь 15–16.08: каталог отдавал туристу в браузер «Ошибка базы данных.
 * Проверьте DATABASE_URL в env.» Это была неправда — подключение живо,
 * падал конкретный запрос из-за неоднозначной колонки. Совет уводил в
 * сторону несколько часов: искали переменную окружения.
 *
 * Два правила, которые здесь держатся:
 *
 *   1. Наружу — нейтральный текст. Публичное сообщение не должно называть
 *      причину, тем более чужую: турист не чинит нашу БД, а ложный диагноз
 *      дороже отсутствия диагноза.
 *   2. В лог — то, чем чинят: SQLSTATE (род поломки называется однозначно,
 *      в отличие от текста), ФОРМА ЗАПРОСА и релиз. Без формы запроса
 *      ошибка не воспроизводится: диагностика 16.08 проверяла `kind=place`,
 *      а падал `kind=route&has_waypoints=true` — зелёный ответ означал лишь,
 *      что спросили не о том.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const PUBLIC_ROUTE = read('app/api/routes/route.ts');
const DIAG = read('app/api/cron/catalog-diag/route.ts');

/** Код без комментариев: в комментариях причина как раз описана — и должна. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PUBLIC_CODE = stripComments(PUBLIC_ROUTE);

describe('публичный каталог не советует чинить DATABASE_URL', () => {
  it('ложного совета в ответе больше нет', () => {
    // В комментарии история упоминается намеренно; запрещён он в коде ответа.
    expect(PUBLIC_CODE).not.toMatch(/DATABASE_URL/);
  });

  it('текст нейтральный и предлагает повтор', () => {
    expect(PUBLIC_CODE).toMatch(/Не удалось загрузить каталог/);
  });

  it('код ответа сохранён — отказ остаётся отказом', () => {
    expect(PUBLIC_ROUTE).toMatch(/status: 503/);
  });
});

describe('доказательство уходит в серверный лог', () => {
  it('логируются SQLSTATE, форма запроса и релиз', () => {
    expect(PUBLIC_ROUTE).toMatch(/sqlstate: e\?\.code/);
    expect(PUBLIC_ROUTE).toMatch(/request: parsed\.data/);
    expect(PUBLIC_ROUTE).toMatch(/release: process\.env\.RELEASE_SHA/);
  });

  it('лог остаётся через console.error — это ошибка, не отладка', () => {
    // console.log в проде запрещён; console.error для сбоя санкционирован.
    expect(PUBLIC_ROUTE).toMatch(/console\.error\('\[\/api\/routes\]/);
    expect(PUBLIC_ROUTE).not.toMatch(/console\.log/);
  });
});

describe('диагностика спрашивает о той ветке, которая падает', () => {
  it('проверяются три формы: place, route, route+has_waypoints', () => {
    expect(DIAG).toMatch(/kind: 'place'/);
    expect(DIAG).toMatch(/kind: 'route'.*sort: 'recommended' \}/s);
    expect(DIAG).toMatch(/has_waypoints: 'true'/);
  });

  it('SQLSTATE и позиция возвращаются, а не только текст', () => {
    // По тексту не отличить синтаксис (42601) от несуществующей колонки
    // (42703) — это гадание, а нужен род поломки.
    expect(DIAG).toMatch(/sqlstate: e\.code/);
    expect(DIAG).toMatch(/position: e\.position/);
  });

  it('прогон не прерывается на первой упавшей ветке', () => {
    // «Падает всё» и «падает одна ветка» чинятся по-разному, и именно это
    // различие отвечает на вопрос о регрессии.
    expect(DIAG).toMatch(/падают все шаги — общая поломка/);
    expect(DIAG).toMatch(/падает \$\{failed\.length\} из \$\{results\.length\}/);
  });

  it('контур закрыт: секрет сверяется постоянным временем', () => {
    expect(DIAG).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
    expect(DIAG).toMatch(/status: 401/);
  });

  it('диагностика только читает', () => {
    expect(DIAG).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
  });
});
