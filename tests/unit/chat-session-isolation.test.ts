/**
 * Идентификатор сессии чата — предъявительский ключ к переписке.
 *
 * GET /api/ai/chat?sessionId=... отдаёт всю историю. Чат начинается анонимным
 * (до входа даётся FREE_MESSAGE_LIMIT сообщений), поэтому пока сессия ничья,
 * id и есть единственный ключ — иначе анонимную беседу было бы не продолжить.
 * Отсюда два условия, каждое из которых легко потерять при рефакторинге:
 *
 *  1. id непредсказуем. Прежний запасной путь давал
 *     `session-<Date.now()>-<8 знаков Math.random()>` и срабатывал не в теории:
 *     `crypto.randomUUID` существует ТОЛЬКО в защищённом контексте, то есть по
 *     обычному http выполнялась именно слабая ветка (CodeQL alert 144).
 *
 *  2. Как только за сессией закреплён аккаунт, одного знания id мало.
 *     В переписке турист называет имя, телефон и планы — те самые данные,
 *     ради которых в репо живут гварды 152-ФЗ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const WIDGET = readFileSync(join(ROOT, 'components/ai/AIChatWidget.tsx'), 'utf-8');
const CHAT_ROUTE = readFileSync(join(ROOT, 'app/api/ai/chat/route.ts'), 'utf-8');

describe('id сессии чата непредсказуем', () => {
  /**
   * Смотрим ТЕЛО функции, а не весь файл: в пояснении над ней Math.random
   * упомянут намеренно — там объясняется, почему его убрали. Проверка по
   * всему файлу запрещала бы объяснять причину, что хуже для следующего
   * читателя, чем сам запрет.
   */
  const body = WIDGET.match(/function createSessionId\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

  it('функция вообще найдена', () => {
    expect(body).not.toBe('');
  });

  it('Math.random не участвует в его получении', () => {
    expect(body).not.toMatch(/Math\.random/);
  });

  it('есть путь для незащищённого контекста — getRandomValues', () => {
    // randomUUID недоступен по http, и без этой ветки пришлось бы вернуться
    // к слабому источнику. Проверяем, что запасной путь именно криптостойкий.
    expect(body).toMatch(/getRandomValues/);
  });

  it('без крипто id не выдаётся вовсе', () => {
    // Лучше сессия без истории, чем угадываемый ключ к чужой переписке.
    expect(body).toMatch(/return '';/);
  });
});

/**
 * Инвариант изоляции. Проверяется на чистой функции — она и есть решение
 * «чужая или нет», а обе точки чтения (GET и POST) обязаны через неё проходить.
 */
describe('чужая сессия недоступна по одному лишь id', () => {
  // Копия правила из route.ts: держим его смысл под тестом.
  function isForeignSession(
    session: { user_id: string | null } | null,
    requesterId: string | null,
  ): boolean {
    return !!session && session.user_id !== null && session.user_id !== requesterId;
  }

  it('анонимная сессия доступна по id — иначе беседу не продолжить', () => {
    expect(isForeignSession({ user_id: null }, null)).toBe(false);
    expect(isForeignSession({ user_id: null }, 'user-1')).toBe(false);
  });

  it('сессия аккаунта доступна ему самому', () => {
    expect(isForeignSession({ user_id: 'user-1' }, 'user-1')).toBe(false);
  });

  it('сессия аккаунта закрыта для другого и для анонима', () => {
    expect(isForeignSession({ user_id: 'user-1' }, 'user-2')).toBe(true);
    expect(isForeignSession({ user_id: 'user-1' }, null)).toBe(true);
  });

  it('несуществующая сессия чужой не считается', () => {
    expect(isForeignSession(null, 'user-1')).toBe(false);
  });
});

describe('роут чата проводит обе точки чтения через проверку', () => {
  it('loadSession читает user_id — без него сравнивать нечего', () => {
    expect(CHAT_ROUTE).toMatch(/SELECT[\s\S]{0,200}user_id[\s\S]{0,80}FROM chat_sessions/);
  });

  it('проверка применяется и в GET, и в POST', () => {
    const uses = CHAT_ROUTE.match(/isForeignSession\(/g) ?? [];
    // Одно объявление + два места применения.
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('в чужую сессию не пишем: сохранение идёт по storableSessionId', () => {
    // ON CONFLICT (session_id) DO UPDATE в saveSession иначе затёр бы чужую
    // переписку по одному знанию id — это запись, а не только чтение.
    expect(CHAT_ROUTE).toMatch(/if \(storableSessionId\) \{\s*await saveSession\(storableSessionId/);
  });
});
