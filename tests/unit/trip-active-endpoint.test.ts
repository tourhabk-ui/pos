/**
 * POST /api/trips/[id]/active — переключатель режима «я в поездке».
 *
 * Эндпоинт меняет то, что человек увидит на главной, и делает это по id из
 * запроса. Значит он обязан быть аккуратен ровно в двух местах: чей это id и
 * что именно гасим.
 *
 * Структурный сторож без сети и БД — как соседние проверки API в этом наборе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/trips/[id]/active/route.ts'), 'utf-8');
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('переключатель режима поездки защищён', () => {
  it('требует аутентификации', () => {
    expect(CODE).toMatch(/requireAuth\(request\)/);
    expect(CODE).toMatch(/instanceof NextResponse/);
  });

  it('проверяет владение поездкой в самом запросе', () => {
    // Не «сначала достали, потом сравнили в JS» — условие в SQL, чтобы чужую
    // поездку нельзя было включить себе.
    expect(CODE).toMatch(/user_id = \$2/);
    expect(CODE).toMatch(/deleted_at IS NULL/);
  });

  it('тело валидируется Zod, а id — по форме UUID', () => {
    expect(CODE).toMatch(/BodySchema/);
    expect(CODE).toMatch(/\[0-9a-f-\]\{36\}/i);
  });

  it('SQL только параметризованный', () => {
    expect(CODE).not.toMatch(/\$\{/);
  });
});

describe('выключение не гасит чужой режим', () => {
  it('снимает активную поездку только если гасят именно её', () => {
    // Иначе вкладка со старым состоянием на одном устройстве выключит режим,
    // включённый на другом, — и человек в поле останется без экрана маршрута.
    expect(CODE).toMatch(/SET active_trip_id = NULL[\s\S]{0,160}?WHERE id = \$1 AND active_trip_id = \$2/);
  });
});

describe('мягкое удаление поездки гасит режим', () => {
  const DEL = readFileSync(join(ROOT, 'app/api/trips/[id]/route.ts'), 'utf-8');
  const DEL_CODE = DEL.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('удаление активной поездки очищает оба поля users', () => {
    // Каскад ON DELETE SET NULL здесь не сработает никогда: удаление мягкое,
    // строка остаётся. Без явной очистки остался бы «призрачный» режим —
    // поездки в списке нет, а главная показывает маршрут, и выключить его
    // штатно нельзя: переключатель отвергает удалённую поездку.
    expect(DEL_CODE).toMatch(/active_trip_id = NULL/);
    expect(DEL_CODE).toMatch(/active_trip_since = NULL/);
  });

  it('удаление неактивной поездки не трогает активную', () => {
    // Во второй вкладке человек мог сделать активной другую поездку.
    expect(DEL_CODE).toMatch(/WHERE id = \$1 AND active_trip_id = \$2/);
  });

  it('оба шага в одной транзакции', () => {
    // Иначе падение между ними оставит ровно то состояние, от которого чиним.
    expect(DEL_CODE).toMatch(/BEGIN/);
    expect(DEL_CODE).toMatch(/COMMIT/);
    expect(DEL_CODE).toMatch(/ROLLBACK/);
    expect(DEL_CODE).toMatch(/client\.release\(\)/);
  });

  it('мягкое удаление идемпотентно и ограничено владельцем', () => {
    expect(DEL_CODE).toMatch(/UPDATE user_trips SET deleted_at = NOW\(\)[\s\S]{0,120}?user_id = \$2[\s\S]{0,60}?deleted_at IS NULL/);
  });
});

describe('инвариант «не более одной активной поездки»', () => {
  it('обеспечен колонкой в users, а не второй таблицей', () => {
    const mig = readFileSync(join(ROOT, 'migrations/791_user_trips_active_mode.sql'), 'utf-8');
    expect(mig).toMatch(/ALTER TABLE users/);
    expect(mig).toMatch(/active_trip_id UUID/);
    // Удаление поездки гасит режим, а не удаляет пользователя.
    expect(mig).toMatch(/ON DELETE SET NULL/);
    // Идемпотентность: миграции накатываются на каждом деплое.
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(mig).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });
});
