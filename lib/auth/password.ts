/**
 * Password Hashing Utilities
 * Uses bcrypt for secure password hashing
 */

import bcrypt from 'bcryptjs';
import { z } from 'zod';

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

/**
 * ЕДИНСТВЕННОЕ правило пароля платформы.
 *
 * До 22.08.2026 функция была написана и не вызывалась ниоткуда, а шесть точек
 * входа держали шесть своих правил: регистрация туриста — `min(6)`,
 * регистрация оператора — `min(8)`, партнёра — `min(8)`, смена пароля — свои.
 * Правило, которое каждый пишет заново, — это не одно правило, а шесть, и
 * слабейшее из них и есть настоящее.
 *
 * Буквы считаются по ЮНИКОДУ, а не по латинице. Прежние `[A-Z]`/`[a-z]`
 * отвергли бы «Вулкан2024»: у русскоязычного туриста заглавная буква русская,
 * и сообщение «нужна заглавная» на пароле с заглавной читается как поломка.
 */
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Пароль должен содержать минимум 8 символов');
  }

  if (!/\p{Lu}/u.test(password)) {
    errors.push('Пароль должен содержать хотя бы одну заглавную букву');
  }

  if (!/\p{Ll}/u.test(password)) {
    errors.push('Пароль должен содержать хотя бы одну строчную букву');
  }

  if (!/\p{Nd}/u.test(password)) {
    errors.push('Пароль должен содержать хотя бы одну цифру');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

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
