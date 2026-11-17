/**
 * create_car_rental_request: заявку отправляет человек на /confirm, как
 * остальные пять (слово владельца 17.11 «Да, на /confirm»). До этого был код
 * подтверждения на втором вызове — его гасил тот же агент (ревью безопасности
 * #3414), и доказательством «да» человека он не был.
 *
 * Поведение вызова (черновик, ссылка, ничего не записано) судит общий список
 * шести заявок — tests/unit/mcp-write-contract.test.ts; здесь — что видит
 * агент в описании инструмента.
 */
import { describe, it, expect } from 'vitest';
import { CAR_RENTAL_REQUEST_TOOL } from '@/lib/mcp/public-tools';

describe('create_car_rental_request: описание — тот же путь /confirm', () => {
  it('велит спросить имя и телефон и отдать человеку ссылку', () => {
    expect(CAR_RENTAL_REQUEST_TOOL.description).toMatch(/спроси у человека имя и телефон/);
    expect(CAR_RENTAL_REQUEST_TOOL.description).toMatch(/Вызов не отправляет заявку: в ответе черновик и ссылка/);
    expect(CAR_RENTAL_REQUEST_TOOL.description).toMatch(/сам нажмёт «Отправить»/);
  });

  it('кода подтверждения нет ни в описании, ни в схеме', () => {
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties).not.toHaveProperty('confirmation');
    expect(CAR_RENTAL_REQUEST_TOOL.description).not.toMatch(/confirmation|Шаг 2|код/i);
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties.consent.description).not.toMatch(/шаг/i);
  });
});
