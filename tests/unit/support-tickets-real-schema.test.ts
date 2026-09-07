// @vitest-environment node
/**
 * Тикеты поддержки — одна модель на всех (04.09).
 *
 * У платформы было два сервиса тикетов: настоящий (lib/support, миграция 078,
 * переписка в JSONB — админка и Telegram-бот) и «столповый» из pillars/,
 * который INSERT-ил колонки description / priority / customer_id /
 * customer_name — их в support_tickets нет. Экран поддержки туриста и три
 * публичных роута сидели на втором: создание тикета падало по построению,
 * а сообщения уходили в ticket_messages, которую никто не читал. Сторожа
 * схемы молчали, потому что pillars/ не сканировался.
 *
 * Сторож держит: публичные роуты и экран туриста — на lib/support; статусы
 * и категории экрана — ровно из CHECK миграции 078; полей priority/tags и
 * таблицы ticket_messages в этом контуре нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '@/lib/support/ticket.service';

// Комментарии срезаются: шапки роутов называют прежние поля (priority,
// description) как урок, и сторож не должен путать урок с кодом.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const R = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf-8'));
const ROUTES = [
  'app/api/support/tickets/route.ts',
  'app/api/support/tickets/[id]/route.ts',
  'app/api/support/tickets/[id]/messages/route.ts',
].map((p) => [p, R(p)] as const);
const CLIENT = R('app/hub/tourist/support/_SupportClient.tsx');
const MIGRATION = readFileSync(join(process.cwd(), 'migrations/078_support_tickets.sql'), 'utf-8');

function checkList(column: string): string[] {
  const m = MIGRATION.match(new RegExp(`${column}[\\s\\S]*?CHECK \\(${column} IN \\(([^)]*)\\)`));
  return (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('публичные роуты тикетов', () => {
  it('идут через lib/support/ticket.service, не через «столповый» сервис', () => {
    for (const [p, src] of ROUTES) {
      expect(src, p).toMatch(/from '@\/lib\/support\/ticket\.service'/);
      expect(src, p).not.toMatch(/from '@\/lib\/services'/);
      expect(src, p).not.toMatch(/ticketMessageService|ticket_messages/);
      expect(src, p).not.toMatch(/\bpriority\b/);
    }
    expect(existsSync(join(process.cwd(), 'lib/services/ticket.service.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'pillars'))).toBe(false);
  });

  it('отказ БД не превращается в тишину', () => {
    for (const [p, src] of ROUTES) {
      expect(src, p).toMatch(/console\.error\('\[support/);
      expect(src, p).not.toMatch(/catch\s*\{\s*\}/);
    }
  });
});

describe('статусы и категории', () => {
  it('константы сервиса равны CHECK миграции 078', () => {
    expect([...TICKET_STATUSES].sort()).toEqual(checkList('status').sort());
    expect([...TICKET_CATEGORIES].sort()).toEqual(checkList('category').sort());
  });

  it('экран туриста знает ровно эти статусы и категории', () => {
    const statuses = [...CLIENT.matchAll(/^\s{2}(\w+): \{ label: '[^']+', icon:/gm)].map((m) => m[1]);
    expect(statuses.sort()).toEqual([...TICKET_STATUSES].sort());
    const cats = [...CLIENT.matchAll(/^\s{2}(\w+): '[^']+',$/gm)].map((m) => m[1]);
    expect(cats.sort()).toEqual([...TICKET_CATEGORIES].sort());
    expect(CLIENT).not.toMatch(/priority|senderType|OPEN:|IN_PROGRESS:/);
  });

  it('переписка — из тикета (role/text/ts), а «нет заявок» и «не загрузились» — разные экраны', () => {
    expect(CLIENT).toMatch(/role: 'user' \| 'agent' \| 'system'/);
    expect(CLIENT).toMatch(/setListError\(/);
    expect(CLIENT).toMatch(/Повторить/);
  });
});
