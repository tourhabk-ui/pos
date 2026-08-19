/**
 * Тело запроса — не удостоверение личности.
 *
 * Находка эволюции #1158 (подтверждена по коду 13.08): `POST /api/telegram/admin`
 * отдаёт лиды с телефонами, HELD-платежи и запускает действия, а вся его защита
 * состояла из `msg.from.id === ownerId`. И `from.id`, и `chat.id` приходят В
 * ТЕЛЕ ЗАПРОСА — их пишет тот, кто стучится. Достаточно было знать URL:
 *
 *   {"message":{"text":"/leads","from":{"id":<владелец>},"chat":{"id":<свой>}}}
 *
 * и персональные данные туристов уходили запросившему. Заголовок
 * X-Telegram-Bot-Api-Secret-Token не читался вовсе, хотя в шапке файла написано,
 * что при регистрации webhook он передаётся.
 *
 * Здесь два уровня проверок: чистая функция сверки секрета и сверка по тексту
 * роута — что `chat.id` из тела больше нигде не адресат. Второе проверяется
 * текстом, потому что поднимать Next-роут с БД и Telegram API в юните дороже,
 * чем польза; ограничение названо, а не спрятано.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyWebhookSecret } from '@/lib/telegram/webhook-secret';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/telegram/admin/route.ts'), 'utf-8');
/** Тело POST-обработчика — только оно, без GET и хелперов. */
const POST_BODY = ROUTE.slice(ROUTE.indexOf('export async function POST'));

describe('сверка секрета webhook', () => {
  it('совпал — ok', () => {
    expect(verifyWebhookSecret('s3cret', 's3cret')).toBe('ok');
  });

  it('не совпал — forbidden', () => {
    expect(verifyWebhookSecret('wrong', 's3cret')).toBe('forbidden');
  });

  it('заголовка нет, а секрет задан — forbidden, а не «ну ладно»', () => {
    expect(verifyWebhookSecret(null, 's3cret')).toBe('forbidden');
  });

  it('секрет не задан — отдельный исход, НЕ «ok»', () => {
    // Незаведённая переменная окружения не должна выглядеть как пройденная
    // проверка: настроенная защита и отсутствующая обязаны быть различимы.
    expect(verifyWebhookSecret('что угодно', undefined)).toBe('not_configured');
    expect(verifyWebhookSecret(null, '')).toBe('not_configured');
  });
});

describe('POST админ-бота: ответ уходит владельцу, а не в чат из тела', () => {
  it('chat.id из тела не используется как адресат', () => {
    // Главная защита, и она работает БЕЗ новых переменных окружения: даже при
    // подделанном from.id данные уйдут владельцу, а не тому, кто их запросил.
    expect(POST_BODY).not.toMatch(/const\s+chatId\s*=\s*msg\.chat\.id/);
    expect(POST_BODY).toMatch(/handleCommand\(cmd,\s*ownerId\)/);
    expect(POST_BODY).toMatch(/handleFreeText\(text,\s*ownerId\)/);
  });

  it('чужому не отвечаем вовсе', () => {
    // Прежнее «Доступ закрыт.» уходило в chat.id из тела — роут работал
    // бесплатным ретранслятором сообщений в любой чат, куда добавлен бот.
    expect(POST_BODY).not.toMatch(/reply\([^)]*Доступ закрыт/);
    expect(POST_BODY).toMatch(/if \(fromId !== ownerId\) return/);
  });

  it('секрет проверяется до разбора тела', () => {
    // Иначе неаутентифицированный payload успел бы попасть в парсер и в логи.
    const secretAt = POST_BODY.indexOf('verifyWebhookSecret');
    const jsonAt = POST_BODY.indexOf('request.json()');
    expect(secretAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeGreaterThan(-1);
    expect(secretAt).toBeLessThan(jsonAt);
  });

  it('несовпавший секрет — 401 без тела', () => {
    expect(POST_BODY).toMatch(/verdict === 'forbidden'\) return new NextResponse\(null, \{ status: 401 \}\)/);
  });

  it('незаданный секрет не роняет бота, но и не молчит', () => {
    // Fail-closed здесь превратил бы защиту данных в отказ сервиса: бот
    // владельца замолчал бы до правки окружения. Поэтому — работаем и говорим.
    expect(POST_BODY).toMatch(/verdict === 'not_configured'/);
    expect(POST_BODY).toMatch(/console\.error\('\[telegram\/admin\]/);
    expect(POST_BODY).not.toMatch(/not_configured'\)\s*return new NextResponse\(null, \{ status: 5/);
  });
});

describe('вторая дверь: тот же дефект в Кузьмиче', () => {
  // Ветка «владелец в личке» открывает PlatformAgent с role:'admin' и
  // публикацию в канал по тому же условию `fromId === ownerId` из тела.
  // Починить одну дверь из двух — не починить: сама находка #1158
  // предупреждала, что дыра просто переезжает на второй роут.
  const KUZMICH = readFileSync(join(process.cwd(), 'app/api/telegram/kuzmich/route.ts'), 'utf-8');

  it('admin-ветка отвечает владельцу, а не в чат из тела', () => {
    expect(KUZMICH).toMatch(/handleApproval\(cmd,\s*ownerId\)/);
    expect(KUZMICH).toMatch(/handleOwnerCommand\(cmd,\s*text,\s*ownerId\)/);
  });

  it('обычные ветки по-прежнему отвечают в chat.id', () => {
    // Кузьмич — ПУБЛИЧНЫЙ бот. Заставить его отвечать только владельцу
    // значило бы сломать его для всех туристов: это была бы не защита,
    // а отказ сервиса под видом защиты.
    expect(KUZMICH).toMatch(/const chatId\s*=\s*msg\.chat\.id/);
  });

  it('секрет проверяется, и он свой, не общий с админ-ботом', () => {
    // Один секрет на двух ботов означает, что компрометация одного
    // открывает второго.
    expect(KUZMICH).toMatch(/TELEGRAM_KUZMICH_WEBHOOK_SECRET/);
    expect(KUZMICH).not.toMatch(/TELEGRAM_ADMIN_WEBHOOK_SECRET/);
  });
});

describe('правило сверки секрета — одно на все webhook-и', () => {
  it('ни один роут не сверяет секрет своим кодом', () => {
    // В webhook/route.ts стояла своя копия с обычным `!==` — то же правило
    // в третьем месте и без защиты от тайминга. Копии правил в этом
    // репозитории расходятся: за один сегодняшний день это случилось со
    // списком глаголов, со стилем линии и с типом ключа.
    for (const p of ['admin', 'kuzmich', 'webhook']) {
      const s = readFileSync(join(process.cwd(), `app/api/telegram/${p}/route.ts`), 'utf-8');
      expect(s, `${p}: сверка секрета мимо общей функции`)
        .not.toMatch(/secret\s*!==\s*expectedSecret/);
      expect(s, `${p}: не зовёт verifyWebhookSecret`).toMatch(/verifyWebhookSecret\(/);
    }
  });
});

describe('открытый прокси к Bot API удалён', () => {
  it('роута /api/telegram/probe/[token] больше нет', () => {
    // Его шапка гласила «токен бота является авторизацией» — но токен присылал
    // ВЫЗЫВАЮЩИЙ, то есть авторизации не было никакой. Любой мог заставить наш
    // сервер вызвать setWebhook для чужого бота и направить его на наш
    // обработчик Кузьмича. Плюс наш собственный токен, когда мы им пользовались,
    // уезжал в путь URL — то есть в логи доступа.
    expect(existsSync(join(process.cwd(), 'app/api/telegram/probe'))).toBe(false);
  });

  it('его работу делают роуты с настоящей авторизацией', () => {
    // Удалять возможность нельзя — можно удалять только дубль. Регистрация
    // webhook живёт в register-kuzmich (CRON_SECRET), диагностика — в check
    // (requireAdmin). Если эти исчезнут, тест напомнит, что мы остались без
    // замены, а не молча потеряли функцию.
    const reg = readFileSync(join(process.cwd(), 'app/api/telegram/register-kuzmich/route.ts'), 'utf-8');
    expect(reg).toMatch(/setWebhook/);
    expect(reg).toMatch(/CRON_SECRET/);
    const check = readFileSync(join(process.cwd(), 'app/api/telegram/check/route.ts'), 'utf-8');
    expect(check).toMatch(/requireAdmin/);
  });
});
