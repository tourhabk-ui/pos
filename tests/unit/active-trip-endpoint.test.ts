/**
 * «Моя активная поездка» отдаётся только своему владельцу и не кэшируется.
 *
 * Повод: колонка `users.active_trip_id` (миграция 791) до сих пор только
 * писалась — `POST /api/trips/[id]/active` её ставит и снимает, а читающего
 * пути не было ни одного. Поэтому `tripProgress()` жил в тестах и никуда не
 * выводился, а режим «я в поездке» на главной построить было не из чего.
 *
 * Два требования к новому эндпоинту, оба про безопасность, а не про удобство:
 *
 *   1. Идентичность — из серверной сессии. Читать поездку по id, присланному
 *      клиентом, и звать это «моей активной» нельзя: так отдаётся чужая.
 *   2. Ответ персональный — `no-store`. На общем телефоне поездка одного
 *      человека не должна достаться другому из кэша.
 *
 * Плюс честность: «День N из M» считает только общая `tripProgress()`, у
 * которой `unknown` при испорченных датах. Пересчитывать её в эндпоинте или
 * подставлять единицу запрещено — это то же враньё, что и обрезанный статус.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE = join(ROOT, 'app/api/trips/active/route.ts');
const SRC = readFileSync(FILE, 'utf-8');
/** Комментарии объясняют запреты и цитируют их — считаем только код. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('эндпоинт существует и защищён', () => {
  it('файл на месте', () => {
    expect(existsSync(FILE)).toBe(true);
  });

  it('требует аутентификации', () => {
    expect(CODE, 'без requireAuth это публичная выдача чужих поездок').toMatch(/requireAuth\(request\)/);
    expect(CODE, 'ответ requireAuth должен прерывать обработку').toMatch(/instanceof NextResponse\)\s*return/);
  });
});

describe('чужую поездку получить нечем', () => {
  it('идентификатор поездки не приходит от клиента', () => {
    // Ни params, ни query: строка выбирается только по серверной идентичности.
    expect(CODE, 'params в этом маршруте означал бы выбор поездки клиентом').not.toMatch(/\bparams\b/);
    expect(CODE, 'searchParams открыл бы выбор чужой поездки').not.toMatch(/searchParams/);
  });

  it('строка выбирается по active_trip_id владельца и перепроверяет user_id', () => {
    expect(CODE).toMatch(/u\.active_trip_id/);
    expect(CODE, 'без сверки user_id JOIN отдал бы поездку другого владельца')
      .toMatch(/t\.user_id\s*=\s*u\.id/);
    expect(CODE, 'удалённая поездка не должна воскресать режимом').toMatch(/deleted_at IS NULL/);
  });

  it('в запрос уходит ровно один параметр — идентичность из сессии', () => {
    expect(CODE).toMatch(/\[auth\.userId\]/);
    // $2 означал бы второй вход, а единственный допустимый — сессия.
    const sql = /`([\s\S]*?)`/.exec(CODE.slice(CODE.indexOf('pool.query')))?.[1] ?? '';
    expect(sql, 'не разобрать SQL').not.toBe('');
    expect(sql, 'второй параметр запроса — потенциальный вход для чужого id').not.toMatch(/\$2/);
  });
});

describe('персональный ответ не оседает в кэше', () => {
  it('отдаётся no-store', () => {
    expect(CODE, 'на общем телефоне кэш покажет чужую поездку').toMatch(/no-store/);
    expect(CODE).toMatch(/private/);
  });

  it('service worker этот путь не кэширует', () => {
    // В sw.js отдельная кэширующая ветка есть только у /api/places/[id];
    // если появится общая для /api/trips — персональные данные лягут в общий кэш.
    const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');
    expect(sw, '/api/trips попал в кэширование service worker`а').not.toMatch(/api\/trips/);
  });
});

describe('день поездки не выдумывается', () => {
  it('прогресс считает общая tripProgress, а не локальная арифметика', () => {
    expect(CODE).toMatch(/tripProgress\(/);
    expect(CODE, 'результат tripProgress не должен досчитываться на месте')
      .not.toMatch(/progress\.(day|total)\s*=/);
  });

  it('нет подстановки дефолтного дня вместо unknown', () => {
    expect(CODE).not.toMatch(/day:\s*1\b/);
    expect(CODE).not.toMatch(/total:\s*1\b/);
  });

  it('отсутствие режима — это данные null, а не ошибка', () => {
    // 404 заставил бы клиент разбирать исключение там, где «режима нет» —
    // нормальное состояние главной.
    expect(CODE).toMatch(/data:\s*null/);
    expect(CODE, 'отсутствие активной поездки не должно быть 404').not.toMatch(/status:\s*404/);
  });
});
