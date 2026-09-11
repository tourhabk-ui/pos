/**
 * Тур сохраняется, даже если тип локации не проставлен, а ошибка приходит
 * по-русски (#1797).
 *
 * `operator_tours.location_type` — nullable без DEFAULT: у туров из импорта и
 * старых миграций он пуст. Форма слала пустое значение в PATCH, `z.enum`
 * отвергал ВЕСЬ запрос, и оператор не мог сохранить в туре ничего — а видел
 * при этом `Invalid option: expected one of "volcano"|…` на английском.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zodErrorMessage } from '@/lib/api/zod-errors';
import { UpdateTourSchema } from '@/lib/api/operator-tours';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('ошибка валидации — человеку, по-русски', () => {
  it('enum: называет поле словами, без списка внутренних значений', () => {
    const r = UpdateTourSchema.safeParse({ location_type: '' });
    expect(r.success).toBe(false);
    const msg = zodErrorMessage((r as { error: z.ZodError }).error);
    expect(msg).toContain('Тип локации');
    expect(msg).not.toContain('volcano');
    expect(msg).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('короткое название и отрицательная цена тоже по-русски', () => {
    const short = UpdateTourSchema.safeParse({ title: 'ab' });
    expect(zodErrorMessage((short as { error: z.ZodError }).error)).toMatch(/^Название: слишком коротко/);
    const price = UpdateTourSchema.safeParse({ base_price: -5 });
    expect(zodErrorMessage((price as { error: z.ZodError }).error)).toContain('Цена');
  });

  it('русское сообщение самой схемы сохраняется как есть', () => {
    const schema = z.object({ title: z.string().min(5, 'нужно хотя бы пять символов') });
    const r = schema.safeParse({ title: 'ab' });
    expect(zodErrorMessage((r as { error: z.ZodError }).error)).toBe('Название: нужно хотя бы пять символов');
  });

  it('оба роута тура зовут общий перевод, а не issues[0].message', () => {
    for (const p of ['app/api/hub/operator/tours/route.ts', 'app/api/hub/operator/tours/[id]/route.ts']) {
      const src = read(p);
      expect(src, p).toMatch(/zodErrorMessage\(error\)/);
      expect(src, p).not.toMatch(/error\.issues\[0\]\?\.message/);
      expect(src, p).not.toMatch(/'Invalid JSON'/);
    }
  });
});

describe('форма тура: пустой тип локации не блокирует сохранение', () => {
  const form = read('app/hub/operator/tours/[id]/_EditTourClient.tsx');

  it('в селектах есть честная опция «не указано», значение из БД не даёт null', () => {
    expect(form).toMatch(/<option value="">— не указано —<\/option>/);
    expect(form).toMatch(/location_type: t\.location_type \?\? ''/);
    expect(form).toMatch(/activity_type: t\.activity_type \?\? ''/);
  });

  it('незаполненный enum не уходит в PATCH', () => {
    expect(form).toMatch(/if \(form\.location_type\) payload\.location_type = form\.location_type;/);
    expect(form).toMatch(/if \(form\.activity_type\) payload\.activity_type = form\.activity_type;/);
  });

  it('PATCH без этих полей проходит валидацию', () => {
    const r = UpdateTourSchema.safeParse({ title: 'Восхождение на вулкан', base_price: 8500 });
    expect(r.success).toBe(true);
  });

  it('подозрительно низкая цена — предупреждение, а не запрет', () => {
    expect(form).toMatch(/SUSPICIOUS_PRICE_RUB = 1000/);
    expect(form).toMatch(/проверьте, не опечатка ли/);
    // Именно предупреждение: сохранение не блокируется.
    expect(form).not.toMatch(/base_price.*<.*SUSPICIOUS_PRICE_RUB.*return;/s);
  });
});
