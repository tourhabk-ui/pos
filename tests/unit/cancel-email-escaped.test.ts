/**
 * Письмо об отмене брони — причина пишется туристом или оператором и шла в
 * HTML письма как есть (CodeQL на PR #2047). Всё введённое людьми — через
 * escapeHtml.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/api/bookings/[id]/cancel/route.ts', 'utf-8');

describe('письмо об отмене экранирует введённое', () => {
  it('причина, название тура и основание возврата — через escapeHtml', () => {
    expect(src).toMatch(/\$\{escapeHtml\(reason\)\}/);
    expect(src).toMatch(/\$\{escapeHtml\(booking\.tour\.title\)\}/);
    expect(src).toMatch(/\$\{escapeHtml\(refund\.reason\)\}/);
    expect(src).not.toMatch(/<\/strong> \$\{reason\}/);
  });
});
