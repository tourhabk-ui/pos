/**
 * Отказ сохранения должен быть виден словами.
 *
 * Живой случай 05.08: владелец правил тур в кабинете и получил
 * «Failed to execute 'json' on 'Response': Unexpected end of JSON input».
 * Это сообщение не о туре и не о базе — это браузер не смог разобрать ПУСТОЙ
 * ответ. Совпали две вещи:
 *
 *   1. В роуте `PATCH /api/admin/operator-tours/[id]` не было ни одного
 *      `try/catch`: любой отказ Postgres ронял обработчик, и Next отдавал
 *      пятисотку без тела.
 *   2. Клиент звал `res.json()` ДО проверки `res.ok`, поэтому пустое тело
 *      превращалось в исключение вместо причины отказа.
 *
 * Порознь каждая — мелочь. Вместе они стоили владельцу возможности починить
 * тур руками, пока миграции не доезжают: интерфейс не сказал ни что сломано,
 * ни где.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Исходник без строк-комментариев: пояснения не должны считаться кодом. */
const code = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROUTE = code(read('app/api/admin/operator-tours/[id]/route.ts'));
const HELPER = read('lib/http/api-response.ts');
const ADMIN_PAGE = code(read('app/hub/admin/content/tours/page.tsx'));
const OPERATOR_PAGE = code(read('app/hub/operator/tours/[id]/_EditTourClient.tsx'));

describe('сервер: отказ базы — это ответ, а не молчание', () => {
  it('каждый обработчик ловит исключение', () => {
    // Три обработчика — GET, PATCH, DELETE. У каждого должен быть свой catch.
    const handlers = ROUTE.match(/export async function (GET|PATCH|DELETE)/g) ?? [];
    expect(handlers.length).toBe(3);
    const catches = ROUTE.match(/catch\s*\(/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(handlers.length);
  });

  it('причина отказа доезжает до клиента, а не теряется', () => {
    expect(ROUTE).toMatch(/function dbFailure/);
    expect(ROUTE).toMatch(/reason:/);
  });

  it('текст ошибки базы чистится от персональных данных', () => {
    // `invalid input syntax for type uuid: "..."` несёт ЗНАЧЕНИЕ, а значением
    // может оказаться телефон или почта туриста.
    expect(ROUTE).toMatch(/redactPII/);
  });

  it('битый идентификатор в URL не роняет роут', () => {
    // BigInt('abc') бросает — раньше это тоже была пятисотка без тела.
    expect(ROUTE).toMatch(/Неверный идентификатор тура/);
  });
});

describe('клиент: пустое тело называется вслух', () => {
  it('общий разбор различает пустой ответ и не-JSON', () => {
    expect(HELPER).toMatch(/пустой ответ/);
    expect(HELPER).toMatch(/не в формате JSON/);
  });

  it('разбор не бросает — любой ответ описуем словами', () => {
    expect(HELPER).toMatch(/JSON\.parse/);
    // Парсинг обёрнут в try, иначе смысл теряется.
    expect(HELPER).toMatch(/try\s*\{[\s\S]*JSON\.parse[\s\S]*\}\s*catch/);
  });

  it('экраны правки тура читают ответ через общий разбор', () => {
    for (const page of [ADMIN_PAGE, OPERATOR_PAGE]) {
      expect(page).toMatch(/readApiResponse/);
    }
  });

  it('в сохранении тура нет голого res.json()', () => {
    // Именно этот вызов и выдал владельцу «Unexpected end of JSON input».
    for (const page of [ADMIN_PAGE, OPERATOR_PAGE]) {
      const save = page.slice(page.indexOf('PATCH'));
      expect(save).not.toMatch(/await res\.json\(\)/);
    }
  });
});
