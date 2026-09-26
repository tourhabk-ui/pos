/**
 * Отказ базы в кабинете владельца жилья называется вслух (§4.0): имя
 * проверки и SQLSTATE. Пустой catch в stay-helpers превращал отказ базы в
 * «Кабинет ещё не настроен» — человек с настроенным кабинетом шёл его
 * настраивать заново, а причину было не найти.
 */

import { sqlState } from '@/lib/guides/db-failure';

export function logStayFailure(check: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[stay] ${check} не выполнился: sqlstate=${sqlState(err)}`, msg);
}

/** Проверку не удалось выполнить — не «нет», а «не знаю». */
export class StayCheckUnavailableError extends Error {
  readonly check: string;
  readonly sqlstate: string;
  constructor(check: string, cause: unknown) {
    super(`[stay] ${check}: проверка не выполнилась`);
    this.name = 'StayCheckUnavailableError';
    this.check = check;
    this.sqlstate = sqlState(cause);
  }
}
