/**
 * Поля клиента агента — одна схема на создание (POST /api/agent/clients) и
 * правку (PUT /api/agent/clients/[id]).
 *
 * Телефон обязателен, почта — нет: бронь за клиента заводится по телефону
 * (оператору нужно, чем связаться с туристом), а почты у человека может не
 * быть. Статус по умолчанию — 'prospect', как у колонки: явный NULL поверх
 * умолчания ронял вставку на NOT NULL (аудит 26.09).
 */

import { z } from 'zod';
import { normalizePhone } from '@/lib/mcp/normalize-phone';

export const CLIENT_STATUSES = ['prospect', 'active', 'inactive'] as const;

export const ClientFieldsSchema = z.object({
  name:    z.string().trim().min(2, 'Имя клиента: минимум 2 символа').max(255),
  phone:   z.string().trim().min(5, 'Укажите телефон клиента').max(50),
  email:   z.union([z.string().trim().email('Некорректный email').max(255), z.literal('')]).optional(),
  company: z.string().trim().max(255).optional(),
  status:  z.enum(CLIENT_STATUSES).default('prospect'),
  notes:   z.string().trim().max(2000).optional(),
  tags:    z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  source:  z.string().trim().max(50).default('direct'),
});

export type ClientFields = z.infer<typeof ClientFieldsSchema>;

export const CLIENT_PHONE_MESSAGE =
  'Проверьте телефон: нужен номер из 10–15 цифр, например +7 900 000 00 00';

/** Нормализованный телефон; null — номер непригоден. */
export function clientPhone(raw: string): string | null {
  return normalizePhone(raw);
}

/** jsonb `tags` приходит из pg уже массивом; мусор — пустой список, не падение. */
export function readTags(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

export function sqlstateOf(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет SQLSTATE';
}
