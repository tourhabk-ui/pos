/**
 * lib/errors/sanitize.ts
 * Security: Sanitize error messages for client responses
 * Never expose stack traces, file paths, or technical details to clients
 */

export interface SafeError {
  message: string;
  code?: string;
  status?: number;
}

/**
 * Convert thrown errors to safe client response
 * - In production: returns generic message
 * - In development: can return full error for debugging
 */
export function sanitizeError(error: unknown, isDev = false): SafeError {
  const isProduction = process.env.NODE_ENV === 'production';

  // If already a safe error object, return as-is
  if (error && typeof error === 'object' && 'message' in error && 'code' in error) {
    return error as SafeError;
  }

  // If it's an Error instance
  if (error instanceof Error) {
    // In development, return full error for debugging
    if (isDev || !isProduction) {
      return {
        message: error.message,
        code: 'INTERNAL_ERROR',
        status: 500,
      };
    }

    // In production, return generic message (never expose stack trace)
    return {
      message: 'An internal error occurred. Please try again later.',
      code: 'INTERNAL_ERROR',
      status: 500,
    };
  }

  // For any other value, return generic message
  return {
    message: isProduction ? 'An unknown error occurred.' : String(error),
    code: 'UNKNOWN_ERROR',
    status: 500,
  };
}

// isDatabaseError убрана 22.08.2026 вслед за logError — своим единственным
// потребителем. Отличать ошибку БД по коду или по подстроке в тексте нужно
// там, где от этого зависит ответ человеку; такого места нет.

// isClientError и logError убраны 22.08.2026 (перепись): ни одна не звалась.
//
// Живут те, которыми пользуются: safeMsg (55 мест) и sanitizeError. Отличать
// клиентскую ошибку от серверной по подстроке в тексте («validation», «not
// found») — способ ненадёжный: сообщение меняют, и код ответа меняется вместе
// с ним незаметно. Понадобится различение — по типу ошибки, а не по её тексту.

/**
 * Safe error message for client response.
 * In production: never exposes raw error.message.
 * In development: returns the actual message for debugging.
 *
 * Drop-in replacement for: `error instanceof Error ? error.message : 'Unknown'`
 */
export function safeMsg(error: unknown, fallback = 'Внутренняя ошибка сервера'): string {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) return fallback;
  if (error instanceof Error) return error.message;
  return String(error);
}
