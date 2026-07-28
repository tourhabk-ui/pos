/**
 * Сервис уведомлений не выдумывает успех.
 *
 * Здесь был худший случай молчаливой поломки за всю сверку схемы. Сервис писал
 * и читал колонку `payload`, которой нет ни в одном файле схемы: таблица
 * `notifications` держит `title` и `message` отдельными NOT NULL, а рядом
 * `data JSONB`. Значит ни один запрос выполниться не мог.
 *
 * И это не падало наружу. `create` ловил ошибку и ВОЗВРАЩАЛ выдуманное
 * уведомление с новым UUID, будто оно сохранено; `markRead`, `markAllRead` и
 * `toggleMute` возвращали `success: true` при неудачном запросе. Вызывающая
 * сторона видела успех, пользователь не получал ничего, а отметка «прочитано»
 * возвращалась непрочитанной на следующем экране.
 *
 * Из двух моделей выбрана табличная: отдельные колонки дают NOT NULL, индексы и
 * внятные запросы. JSON-мешок не даёт ничего из этого и молча теряет форму.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/services/operators/notification.service.ts'), 'utf-8');

/** Только код: комментарии рядом объясняют решение и цитируют старые имена. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('запись идёт в объявленные колонки', () => {
  it('INSERT перечисляет title и message, а не мешок payload', () => {
    expect(CODE).toContain('INSERT INTO notifications (user_id, type, title, message, data');
    expect(CODE).not.toMatch(/INSERT INTO notifications[^`]*payload/);
  });

  it('из базы колонка payload не запрашивается', () => {
    expect(CODE).not.toMatch(/SELECT[^`]*\bpayload\b[^`]*FROM notifications/);
  });

  it('отключение звука пишется в data, а не в payload', () => {
    expect(CODE).toContain("jsonb_set(COALESCE(data, '{}'::jsonb), '{muted}'");
  });

  it('признак прочтения держится согласованным в обеих колонках', () => {
    // В таблице есть и read_at, и is_read. Обновлять одну, забыв вторую, —
    // готовить расхождение, которое всплывёт в другом запросе.
    const marks = CODE.match(/SET read_at = NOW\(\), is_read = TRUE/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('неудача не выдаётся за успех', () => {
  it('create не возвращает выдуманное уведомление', () => {
    // Именно эта строка делала поломку невидимой.
    expect(CODE).not.toContain('crypto.randomUUID()');
  });

  it('в сервисе не осталось глушителей ошибок с фиктивным успехом', () => {
    expect(CODE).not.toContain('no-op fallback');
    // getById/getByIdForUser/delete* по-прежнему могут вернуть null или false —
    // это честный ответ «не нашли», а не подделанный успех.
    const silentSuccess = /catch\s*\{[^}]*\}\s*\n\s*return\s*\{\s*success:\s*true/g;
    expect(CODE).not.toMatch(silentSuccess);
  });

  it('уведомление без текста отвергается сразу и по-русски', () => {
    expect(SRC).toContain('Уведомление без заголовка или текста не создаётся');
  });
});

describe('форма ответа для клиента не сломана', () => {
  it('поле payload собирается из колонок — снаружи разницы нет', () => {
    expect(CODE).toContain('payload: { title, message, channels, data: payloadData, muted }');
  });

  it('чтение терпимо к старой форме строки', () => {
    // Если строка всё же придёт с payload (база, где колонку добавили руками),
    // значения возьмутся оттуда, а не потеряются.
    expect(CODE).toContain('const legacy = asRecord(row.payload);');
  });
});
