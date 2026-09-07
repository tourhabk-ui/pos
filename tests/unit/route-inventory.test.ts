// @vitest-environment node
/**
 * Перепись периметра: у каждого роута назван род защиты, а «не нашли»
 * заморожено и может только сокращаться.
 *
 * Внешний аудит 07.09: «754 роута — уровень, где на middleware полагаться
 * уже нельзя». Возражение верное, но вывод из него делали неверный. Edge
 * (`middleware.ts`) возвращает 401 всякому `/api`, которого нет в реестре
 * `PUBLIC_API_ROUTES`, — подлинность проверяется всегда. Открытых дверей
 * перепись не нашла; нашла другое: два десятка роутов, у которых не видно
 * проверки ПРАВ и ВЛАДЕНИЯ. Разница ровно та, из-за которой вошедший под
 * собой турист читает чужую бронь.
 *
 * ── Почему список замораживается, а не чинится разом ──────────────────────
 *
 * Двадцать три случая разбираются глазами по одному: у каждого свой ответ.
 * `/api/geocode` и `/api/docs` открыты правильно и им место в реестре
 * публичных; `/api/engagement/messages/[id]` требует проверки владения;
 * `/api/webhooks/payments` отвечает 501 и его надо просто удалить. Чинить их
 * одним движком — значит выдумать общее правило там, где его нет.
 *
 * Заморозка делает работу видимой: новый роут без видимой проверки и без
 * записи в реестр публичных красит сборку. Молчание тут не ответ (§4.0).
 *
 * ── Чего сторож НЕ утверждает ─────────────────────────────────────────────
 *
 * `needs_review` значит «не нашли», а не «не защищено». Проверка идёт на один
 * переход вглубь — роут плюс его локальные импорты, — и глубже не идёт
 * сознательно: двухходовка находила бы защиту через общие утилиты и красила
 * всё зелёным, что хуже, чем не проверять.
 */
import { describe, it, expect } from 'vitest';
import { inventoryRoutes, summarize } from '@/lib/security/route-inventory';

const ROOT = process.cwd();
const records = inventoryRoutes(ROOT);
const summary = summarize(records);

/**
 * Замер 07.09. Список может только СОКРАЩАТЬСЯ: разобрали случай — вычеркнули
 * строку тем же коммитом, что и починку. Добавление сюда — осознанное решение
 * с объяснением в PR, а не способ погасить красный тест.
 */
const NEEDS_REVIEW_FROZEN = [
  '/api/affiliate/link',
  '/api/agent/plan',
  '/api/ai',
  '/api/ai/deepseek',
  '/api/ai/smart-search',
  '/api/ai/vision',
  '/api/bots/reposter/webhook',
  '/api/chat',
  '/api/docs',
  '/api/engagement/conversations',
  '/api/engagement/messages',
  '/api/engagement/messages/[id]',
  '/api/geocode',
  '/api/kamchatka-routes',
  '/api/meta/catalog',
  '/api/safety/alerts',
  '/api/safety/visit',
  '/api/sales/campaign/execute',
  '/api/sales/campaign/launch',
  '/api/tourist/feedback/agent',
  '/api/trip/plan',
  '/api/webhooks/payments',
  '/api/webhooks/travelpayouts',
] as const;

describe('перепись охватывает весь периметр', () => {
  it('роутов найдено столько, сколько их есть', () => {
    // Не точное число: оно растёт. Порядок величины — чтобы перепись,
    // случайно начавшая смотреть не туда, не выглядела успешной.
    expect(records.length).toBeGreaterThan(700);
  });

  it('охраняемых — подавляющее большинство, и это измерено', () => {
    expect(summary.guarded).toBeGreaterThan(500);
    // Публичные объявлены явно, а не получились сами собой.
    expect(summary.declared_public).toBeGreaterThan(50);
  });

  it('у каждой записи назван род защиты', () => {
    for (const r of records) {
      expect(['guarded', 'signature', 'declared_public', 'needs_review']).toContain(r.protection);
    }
  });
});

describe('«не нашли проверку» — список заморожен и только сокращается', () => {
  const actual = records.filter((r) => r.protection === 'needs_review').map((r) => r.url).sort();
  const frozen = [...NEEDS_REVIEW_FROZEN].sort();

  it('новых роутов без видимой проверки не появилось', () => {
    const added = actual.filter((u) => !frozen.includes(u));
    expect(
      added,
      'роут заведён без видимой проверки прав и без записи в реестр публичных. '
      + 'Либо добавьте проверку, либо объявите его публичным в lib/auth/public-api-routes.ts',
    ).toEqual([]);
  });

  it('разобранные случаи вычеркнуты из списка вместе с починкой', () => {
    const stale = frozen.filter((u) => !actual.includes(u));
    expect(
      stale,
      'эти роуты уже не в needs_review — вычеркните их из NEEDS_REVIEW_FROZEN, '
      + 'иначе список перестанет что-либо значить',
    ).toEqual([]);
  });
});

describe('заморожено «не нашли», а не «открыто»', () => {
  /**
   * Проверяется свойство самой переписи, а не данных: если однажды кто-то
   * упростит классификатор до «есть ли слово auth в файле», разница между
   * «не нашли» и «открыто» исчезнет молча.
   */
  it('перепись смотрит и в импортированные модули, а не только в роут', () => {
    // /api/bookings/[id] охраняется verifyAuth и сверкой владения через
    // getBookingForUser — первая редакция переписи считала его неохраняемым.
    const booking = records.find((r) => r.url === '/api/bookings/[id]');
    expect(booking?.protection).toBe('guarded');

    // Приём CloudPayments проверяет HMAC внутри processCloudPaymentsWebhook,
    // то есть на импорт дальше самого роута.
    const cp = records.find((r) => r.url === '/api/webhooks/cloudpayments');
    expect(cp && ['guarded', 'signature']).toBeTruthy();
    expect(cp?.protection).not.toBe('needs_review');
  });
});
