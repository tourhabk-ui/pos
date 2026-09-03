/**
 * session_id и источник веб-гостя видны в админке, а не только в ответе API.
 *
 * ── Случай 03.09 ───────────────────────────────────────────────────────────
 *
 * Живая переписка гостя про Авачинский («кроссовки и ветровка, нормально?»)
 * — владелец спросил «кто тестировал» и не смог ответить сам: `sessionId`
 * уже приходил в `/api/admin/ai-analytics/chats`, но нигде не рендерился —
 * ни кнопки скопировать, ни строки источника. Различить «реальный турист» и
 * «свои потыкали виджет» по данным всё равно нельзя (IP не пишем), но
 * источник перехода — уже что-то, и он был виден только прямым запросом к
 * БД, которого у владельца нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ROUTE = strip(read('app/api/admin/ai-analytics/chats/route.ts'));
const CLIENT = strip(read('app/hub/admin/ai-analytics/_AIAnalyticsClient.tsx'));

describe('API отдаёт источник перехода', () => {
  it('referrer_source и utm_source выбираются из chat_sessions', () => {
    expect(ROUTE).toMatch(/referrer_source/);
    expect(ROUTE).toMatch(/utm_source/);
  });

  it('оба поля доезжают до JSON-ответа', () => {
    expect(ROUTE).toMatch(/referrerSource:\s*r\.referrer_source/);
    expect(ROUTE).toMatch(/utmSource:\s*r\.utm_source/);
  });
});

describe('интерфейс WebChat знает про новые поля', () => {
  it('типы объявлены', () => {
    const at = CLIENT.indexOf('interface WebChat');
    const block = CLIENT.slice(at, at + 300);
    expect(block).toMatch(/referrerSource: string \| null/);
    expect(block).toMatch(/utmSource: string \| null/);
  });
});

describe('session_id виден и копируется', () => {
  it('CopyButton принимает произвольный текст и заголовок, не только chat_id', () => {
    const at = CLIENT.indexOf('function CopyButton');
    const block = CLIENT.slice(at, at + 400);
    expect(block).toMatch(/display\?:\s*string/);
    expect(block).toMatch(/title\s*=\s*'Скопировать chat_id'/);
  });

  it('веб-чат рендерит кнопку копирования session_id', () => {
    expect(CLIENT).toMatch(/CopyButton value=\{web\.sessionId\}/);
    expect(CLIENT).toMatch(/title="Скопировать session_id"/);
  });
});

describe('источник виден при разворачивании переписки, с честным «не передан»', () => {
  it('строка источника есть для веб-чатов', () => {
    const at = CLIENT.indexOf('{!isTg && (');
    // ищем именно блок про источник, а не про CopyButton (тоже начинается с {!isTg
    const srcAt = CLIENT.indexOf('Источник:');
    expect(srcAt, 'строка источника не найдена').toBeGreaterThan(at);
  });

  it('пустой источник называется словами, а не пропадает молча', () => {
    const srcAt = CLIENT.indexOf('Источник:');
    const block = CLIENT.slice(srcAt, srcAt + 300);
    expect(block).toMatch(/не передан/);
  });
});
