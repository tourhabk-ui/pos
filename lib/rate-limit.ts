/**
 * In-memory rate limiter for API routes.
 * Works per Node.js process — sufficient for single-instance Timeweb deployment.
 * Falls back gracefully: if checking fails, request is allowed through.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
 *   const allowed = limiter.check(ip);
 *   if (!allowed) return apiError('Слишком много запросов', 429);
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterOptions {
  /** Window size in milliseconds */
  windowMs: number;
  /** Max requests per window per key */
  max: number;
}

export interface RateLimitStatus {
  /** Number of requests remaining in current window */
  remaining: number;
  /** Unix timestamp (ms) when window resets */
  resetAt: number;
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited */
  check(key: string): boolean;
  /** Get current rate limit status for a key */
  getStatus(key: string, max: number): RateLimitStatus;
}

export function createRateLimiter({ windowMs, max }: RateLimiterOptions): RateLimiter {
  const store = new Map<string, RateLimitEntry>();

  // Cleanup entries older than 2× the window to prevent unbounded growth.
  // Called inline — no setInterval needed (Edge/serverless friendly).
  function cleanup(): void {
    const cutoff = Date.now() - windowMs * 2;
    for (const [k, entry] of store.entries()) {
      if (entry.resetAt < cutoff) store.delete(k);
    }
  }

  return {
    check(key: string): boolean {
      cleanup();
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || entry.resetAt <= now) {
        store.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (entry.count >= max) {
        return false;
      }

      entry.count += 1;
      return true;
    },
    getStatus(key: string, max: number): RateLimitStatus {
      cleanup();
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || entry.resetAt <= now) {
        return {
          remaining: max - 1,
          resetAt: now + windowMs,
        };
      }

      return {
        remaining: Math.max(0, max - entry.count),
        resetAt: entry.resetAt,
      };
    },
  };
}

/**
 * IP клиента для лимитов, согласий и журналов.
 *
 * Замер на проде 21.11 (проба `client-ip-headers-probe`, прогоны Actions с
 * подделкой и без): прокси перед контейнером (Caddy) ПЕРЕЗАПИСЫВАЕТ
 * X-Forwarded-For одним элементом — настоящим адресом клиента, присланный
 * клиентом XFF до приложения не доходит. А X-Real-IP и CF-Connecting-IP
 * прокси пропускает как есть: документационные адреса из запроса пробы
 * дошли до приложения. До этой правки доверенный порядок брал x-real-ip
 * первым — и любой лимит по IP (вход, MFA, чат Кузьмича) обходился одной
 * строкой заголовка.
 *
 * Теперь адрес решает один человек — прокси контейнера `start.js`: он стирает
 * присланные клиентом X-Real-IP / CF-Connecting-IP / True-Client-IP /
 * X-Client-IP / Forwarded и ставит X-Real-IP и X-Forwarded-For одним
 * значением — ПРАВЫМ элементом XFF от Caddy (или адресом сокета, если XFF
 * нет). Next слушает только 127.0.0.1:3001, мимо start.js к нему не попасть.
 * Здесь: x-real-ip (его ставит start.js) → правый элемент XFF. CF-Connecting-IP
 * не читается вовсе: Cloudflare перед Ведаром нет. Сторож:
 * tests/unit/client-ip-trusted-proxy.test.ts.
 */
export function getTrustedClientIp(headers: Headers): string {
  return getTrustedClientIpOrNull(headers) ?? '127.0.0.1';
}

/**
 * Тот же доверенный порядок, но без выдуманного запаса: null — ни один
 * заголовок адреса не пришёл. Для ЗАПИСИ адреса (согласие, журнал событий,
 * клики), где '127.0.0.1' был бы ложью о том, откуда пришёл человек, а не
 * безобидным ключом лимита (§4.0).
 */
export function getTrustedClientIpOrNull(headers: Headers): string | null {
  return headers.get('x-real-ip')?.trim()
    || lastForwardedFor(headers.get('x-forwarded-for'))
    || null;
}

/** Правый элемент X-Forwarded-For — его дописывает ближайший к нам прокси. */
export function lastForwardedFor(value: string | null | undefined): string | null {
  if (!value) return null;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items[items.length - 1] : null;
}

/**
 * Старое имя, 57 вызовов. С 21.11 — тот же доверенный порядок: первый
 * элемент XFF, который брался раньше, пишет клиент.
 */
export function getClientIp(headers: Headers): string {
  return getTrustedClientIp(headers);
}
