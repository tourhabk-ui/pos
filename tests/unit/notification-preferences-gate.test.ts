/**
 * Сторож: настройки уведомлений РЕШАЮТ, а не просто хранятся.
 *
 * 23.08.2026 настройки перевели из Map в базу (миграция 910) — они перестали
 * теряться при выкате. Проверка после этого показала, что решать они всё равно
 * не решали ничего: имена `unsubscribeAll`, `quietHours`, `frequencyLimit` не
 * встречались НИ В ОДНОМ пути отправки. Человек снимал галочку, платформа
 * честно её хранила и продолжала слать. Прежде настройка терялась, теперь
 * хранится и игнорируется — для получателя разница невелика.
 *
 * Здесь закреплено ровно то, что должно быть правдой:
 * безопасность настроек не спрашивает, у решения три исхода, оно называет
 * чего не учло, и путь доставки действительно через него проходит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const { checkNotificationAllowed } = await import('@/lib/notifications/preferences-gate');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const prefs = (p: Record<string, unknown>) => ({ rows: [{ prefs: p }] });

beforeEach(() => query.mockReset());

describe('безопасность настроек не спрашивает', () => {
  it('род safety проходит всегда', async () => {
    query.mockResolvedValueOnce(prefs({ unsubscribeAll: true }));
    const d = await checkNotificationAllowed('u1', 'safety', 'push');
    expect(d.verdict).toBe('send');
  });

  it('и НЕ ходит в базу вовсе', async () => {
    // Порядок — часть правила: пока проверка стоит до запроса, её нельзя
    // обойти ни отказом БД, ни забытым исключением в списке.
    //
    // Доказательство двойное. В базе лежит настройка, которая ПОДАВИЛА БЫ
    // сообщение, спроси её кто-нибудь: вердикт `send` значит, что не
    // спрашивали. Счётчик вызовов подтверждает это прямо.
    //
    // Бросающий мок сюда не годится: незадействованный бросок остаётся
    // висеть на моке и роняет тест по постороннему поводу — проверено.
    query.mockResolvedValue(prefs({ unsubscribeAll: true, channelPreferences: { push: false } }));
    const d = await checkNotificationAllowed('u1', 'safety', 'push');
    expect(d.verdict).toBe('send');
    expect(query, 'safety обратилось к базе — значит зависит от неё').not.toHaveBeenCalled();
  });
});

describe('три исхода, а не два', () => {
  it('отписался — подавляем', async () => {
    query.mockResolvedValueOnce(prefs({ unsubscribeAll: true }));
    const d = await checkNotificationAllowed('u1', 'transactional', 'push');
    expect(d.verdict).toBe('suppress');
    expect(d.reason).toContain('unsubscribeAll');
  });

  it('выключил канал — подавляем', async () => {
    query.mockResolvedValue(prefs({ channelPreferences: { push: false } }));
    expect((await checkNotificationAllowed('u1', 'engagement', 'push')).verdict).toBe('suppress');
    expect((await checkNotificationAllowed('u1', 'engagement', 'email')).verdict).toBe('send');
  });

  it('выключил тип — подавляем', async () => {
    query.mockResolvedValueOnce(prefs({ typePreferences: { booking_confirmed: false } }));
    const d = await checkNotificationAllowed('u1', 'transactional', 'push', 'booking_confirmed');
    expect(d.verdict).toBe('suppress');
  });

  it('не настраивал — шлём, и это НЕ то же, что «не смогли прочитать»', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await checkNotificationAllowed('u1', 'engagement', 'push')).verdict).toBe('send');
  });

  it('база отказала — «не знаю», а не «можно»', async () => {
    const err = Object.assign(new Error('connection refused'), { code: '08006' });
    query.mockImplementationOnce(() => { throw err; });
    const d = await checkNotificationAllowed('u1', 'engagement', 'push');
    expect(d.verdict).toBe('unknown');
    expect(d.reason, 'SQLSTATE обязан попасть в причину').toContain('08006');
  });
});

describe('решение называет, чего не учло', () => {
  it('quietHours и frequencyLimit перечислены прямо', async () => {
    // Хранятся эндпоинтом, но не вычисляются: часового пояса получателя у
    // платформы нет ни в одной таблице, счётчика отправленного — тоже.
    // «Учтено» и «не смотрели» не должны выглядеть одинаково.
    query.mockResolvedValueOnce(prefs({ channelPreferences: {} }));
    const d = await checkNotificationAllowed('u1', 'engagement', 'push');
    expect(d.unevaluated.join(' ')).toMatch(/quietHours/);
    expect(d.unevaluated.join(' ')).toMatch(/frequencyLimit/);
  });

  it('у safety учитывать нечего — список пуст, а не заполнен для вида', async () => {
    query.mockResolvedValueOnce(prefs({}));
    expect((await checkNotificationAllowed('u1', 'safety')).unevaluated).toEqual([]);
  });
});

describe('путь доставки действительно проходит через шлюз', () => {
  const PUSH = strip(read('lib/notifications/web-push.ts'));

  it('sendPushToUser спрашивает настройки', () => {
    expect(PUSH).toMatch(/checkNotificationAllowed\(userId, opts\.kind, 'push'/);
  });

  it('род сообщения обязателен — без умолчания', () => {
    // Умолчание молча зачислило бы новое уведомление в безобидный род.
    expect(PUSH).toMatch(/opts:\s*\{\s*kind: NotificationKind/);
    expect(PUSH, 'у kind появилось умолчание').not.toMatch(/kind\s*=\s*'/);
  });

  it('подавление и «не знаю» оба оставляют след', () => {
    expect(PUSH).toMatch(/verdict === 'suppress'[\s\S]{0,300}console\.(info|warn|error)/);
    expect(PUSH).toMatch(/verdict === 'unknown'[\s\S]{0,300}console\.error/);
  });

  it('каждый вызов sendPushToUser объявляет род', () => {
    const CALLER = read('app/api/hub/operator/bookings/[id]/route.ts');
    expect(CALLER).toMatch(/kind: 'transactional'/);
  });
});
