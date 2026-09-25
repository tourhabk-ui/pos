/**
 * Password Hashing Utilities
 * Uses bcrypt for secure password hashing
 */

import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { validatePassword } from '@/lib/auth/password-rule';

// Align bcrypt cost across the app; 12 is baseline for production workloads.
const SALT_ROUNDS = 12;

/**
 * Hash a password
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

// Само правило живёт в lib/auth/password-rule.ts — без bcrypt, чтобы его
// могли импортировать и клиентские формы (/operators/join): подсказка
// «Минимум 6 символов» на форме при правиле из восьми с заглавной и цифрой
// стоила человеку лишнего похода к серверу.
export { validatePassword, PASSWORD_RULE_HINT } from '@/lib/auth/password-rule';

/**
 * То же правило схемой Zod — чтобы маршруты его не переписывали.
 *
 * Сообщения приходят все сразу: «минимум 8 символов», а после исправления
 * «нужна цифра» — это два похода вместо одного.
 */
export const passwordSchema = z
  .string({ message: 'Пароль обязателен' })
  .max(200, 'Пароль длиннее 200 символов')
  .superRefine((value, ctx) => {
    for (const message of validatePassword(value).errors) {
      ctx.addIssue({ code: 'custom', message });
    }
  });
