// @vitest-environment node
/**
 * Номер брони больше не пропуск.
 *
 * ── Что было найдено 08.09 ────────────────────────────────────────────────
 *
 * `operator_bookings.id` — BIGSERIAL. Роут `GET /api/hub/bookings/[id]` стоит
 * в реестре публичных (гостевая бронь по устройству), владения не проверял
 * вовсе — `WHERE b.id = $1` — и отдавал имя туриста, дату, цену и статус
 * оплаты любому, кто назвал номер.
 *
 * Хуже была вторая половина. Тот же ответ содержал `pdf_token` — HMAC от
 * номера, задуманный ИМЕННО как защита PDF от перебора номеров (так написано
 * в шапке удалённого lib/pdf/pdf-token.ts). Замок выдавался тому, от кого он
 * защищал, а PDF по нему отдаёт договор с телефоном и почтой:
 *
 *   GET /api/hub/bookings/1..N          → имя, дата, цена + pdf_token
 *   GET /api/hub/bookings/N/pdf?token=… → PDF с телефоном и почтой
 *
 * Класс — BOLA/IDOR плюс раскрытие ПД. Перебор не требовал ни входа, ни
 * угадывания: номера идут подряд.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Он судит УСТРОЙСТВО, а не поведение живой базы (это делает
 * tests/integration/booking-access.pg.test.ts): что ключ проверяется, что
 * проверка одна на оба роута, что отказ — 404, что токен-HMAC не вернулся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bookingTokenFrom } from '@/lib/bookings/access';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const JSON_ROUTE = read('app/api/hub/bookings/[id]/route.ts');
const PDF_ROUTE  = read('app/api/hub/bookings/[id]/pdf/route.ts');
const CREATE     = read('app/api/hub/bookings/create/route.ts');
const ACCESS     = read('lib/bookings/access.ts');
const MIGRATION  = read('migrations/943_operator_bookings_access_token.sql');
const SUCCESS    = read('app/booking-success/[id]/_BookingSuccessClient.tsx');

/** Код без комментариев: судим употребление, а не упоминание в шапке. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('оба роута брони спрашивают ключ, и спрашивают одинаково', () => {
  it('JSON подтверждения проверяет доступ до выдачи данных', () => {
    const c = code(JSON_ROUTE);
    expect(c).toContain('verifyBookingAccess');
    // Проверка обязана стоять ДО запроса к базе, иначе данные уже прочитаны.
    expect(c.indexOf('verifyBookingAccess')).toBeLessThan(c.indexOf('FROM operator_bookings'));
  });

  it('PDF проверяет тот же ключ той же функцией', () => {
    const c = code(PDF_ROUTE);
    expect(c).toContain('verifyBookingAccess');
    expect(c.indexOf('verifyBookingAccess')).toBeLessThan(c.indexOf('FROM operator_bookings'));
  });

  it('копии проверки нет: своего сравнения токена в роутах не осталось', () => {
    for (const [name, src] of [['json', JSON_ROUTE], ['pdf', PDF_ROUTE]] as const) {
      expect(code(src), `${name}: своя копия правила разойдётся с общей`)
        .not.toMatch(/access_token\s*(===|!==)/);
    }
  });
});

describe('прежний замок снят целиком', () => {
  it('модуль pdf-token удалён вместе с запасным секретом no-secret', () => {
    expect(existsSync(join(ROOT, 'lib/pdf/pdf-token.ts'))).toBe(false);
  });

  it('pdf_token наружу не отдаётся — иначе перебор снова получит ключ', () => {
    expect(code(JSON_ROUTE)).not.toMatch(/pdf_token\s*:/);
    expect(code(JSON_ROUTE)).not.toContain('makePdfToken');
  });

  it('страница подтверждения больше не ждёт pdf_token в ответе', () => {
    expect(code(SUCCESS)).not.toContain('pdf_token');
  });
});

describe('отказ не подтверждает существование брони', () => {
  /**
   * 403 сказал бы «бронь есть, но не твоя» — половина добычи перебора.
   * Поэтому и у чужого ключа, и у несуществующего номера исход один.
   */
  it('оба роута отвечают 404, а не 403', () => {
    for (const [name, src] of [['json', JSON_ROUTE], ['pdf', PDF_ROUTE]] as const) {
      const denied = src.slice(src.indexOf("access.state === 'denied'"));
      expect(denied.slice(0, 300), `${name}: отказ обязан быть 404`).toContain('status: 404');
      expect(denied.slice(0, 300), `${name}: 403 выдаёт существование брони`).not.toContain('403');
    }
  });

  it('«не смог проверить» — отдельный исход, а не отказ (§4.0)', () => {
    for (const [name, src] of [['json', JSON_ROUTE], ['pdf', PDF_ROUTE]] as const) {
      expect(src, `${name}: третий исход не обработан`).toContain("access.state === 'unknown'");
      const unknown = src.slice(src.indexOf("access.state === 'unknown'"));
      expect(unknown.slice(0, 300)).toContain('status: 503');
    }
  });
});

describe('ключ доезжает до туриста ровно один раз', () => {
  it('create возвращает access_token из RETURNING, а не выдумывает', () => {
    expect(CREATE).toMatch(/RETURNING id, access_token/);
    expect(CREATE).toMatch(/access_token:\s*result\.accessToken/);
  });

  it('страница подтверждения читает ключ из ссылки и шлёт его в запрос', () => {
    expect(SUCCESS).toMatch(/URLSearchParams\(window\.location\.search\)\.get\('t'\)/);
    expect(SUCCESS).toMatch(/bookings\/\$\{bookingId\}\?token=/);
  });
});

describe('сама проверка ключа', () => {
  it('сравнение по постоянному времени, а не оператором', () => {
    expect(ACCESS).toContain('timingSafeCompare');
    expect(code(ACCESS), 'побайтное сравнение подбирается по времени ответа')
      .not.toMatch(/expected\s*(===|!==)\s*token/);
  });

  it('форма ключа проверяется до похода в базу', () => {
    expect(ACCESS).toMatch(/UUID_RE\.test\(token\)/);
  });

  it('отказ базы не глушится: в логе имя проверки и SQLSTATE', () => {
    expect(ACCESS).toContain('[booking-access]');
    expect(ACCESS).toContain('SQLSTATE');
  });

  it('ключ берётся из ссылки или заголовка — оба пути ведут в одну функцию', () => {
    const h = new Headers();
    expect(bookingTokenFrom(new URL('https://x/y?token=abc'), h)).toBe('abc');
    h.set('X-Booking-Token', 'def');
    expect(bookingTokenFrom(new URL('https://x/y'), h)).toBe('def');
    expect(bookingTokenFrom(new URL('https://x/y'), new Headers())).toBe('');
  });

  it('мусор вместо ключа отвергается формой, а не запросом', async () => {
    const { verifyBookingAccess } = await import('@/lib/bookings/access');
    // Ни одного обращения к базе тут быть не должно: форма не подошла.
    expect((await verifyBookingAccess(1, 'не-uuid')).state).toBe('denied');
    expect((await verifyBookingAccess(1, '')).state).toBe('denied');
  });
});

describe('миграция засыпает старые брони разными ключами', () => {
  it('колонка есть, ключ случайный и уникальный', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS access_token UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_bookings_access_token/);
  });

  it('засыпка идёт волатильным DEFAULT, а не одним UPDATE на всех', () => {
    // Один UPDATE с одним значением выдал бы всем броням ОБЩИЙ ключ — это
    // ровно та же дыра, только с 36 символами вместо номера.
    expect(MIGRATION).not.toMatch(/UPDATE operator_bookings\s+SET access_token/);
  });
});
