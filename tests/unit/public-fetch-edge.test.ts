/**
 * Публичная страница не зовёт API, которое Edge молча режет.
 *
 * Класс бага 21-22.08: клиентский код публичной страницы делает fetch к
 * /api-пути, которого нет в реестре публичных, — Edge отвечает
 * `401 Не авторизован` ДО кода роута, и функция мертва для гостя. Так
 * умерли форма полевой проверки, а перепись 22.08 нашла 75 таких вызовов:
 * поиск, каталоги, календарь, предупреждения безопасности. Залогиненный
 * владелец не видел этого никогда — у него есть кука.
 *
 * Сторож повторяет перепись на каждом прогоне:
 *   - собирает fetch('/api/...') из клиентских файлов ВНЕ разделов за входом;
 *   - спрашивает НАСТОЯЩИЙ реестр (isPublicApiPath), не копию правил;
 *   - непубличный вызов обязан быть в замороженном списке ниже.
 *
 * Список — не индульгенция, а учёт долга: каждая запись — вызов личного
 * API с публичной страницы, где клиент обязан сам обработать «нет входа»
 * (показать «Войти», спрятать блок — что угодно, кроме молчания). Список
 * может только СОКРАЩАТЬСЯ; новая запись требует того же решения, что и
 * запись в реестре: либо путь открывается осознанно, либо клиент гейтится.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'api']);
/** Разделы за входом: их клиенты законно зовут защищённые API. */
const PROTECTED_PREFIXES = ['app/hub', 'app/profile', 'app/operator'].map(p => join(ROOT, p));
/**
 * Компоненты, монтируемые ТОЛЬКО на страницах за входом. Каталог components/
 * не знает, где его используют, поэтому принадлежность фиксируется здесь
 * по имени каталога.
 */
const PROTECTED_COMPONENT_DIRS = [
  'components/hub', 'components/operator', 'components/agent',
  'components/transfer-operator/Dashboard',
].map(p => join(ROOT, p));

/**
 * Учёт долга: личные API, которые публичная страница зовёт с обработкой
 * отсутствия входа на клиенте. Формат: "METHOD путь" («X» — сегмент-параметр).
 */
const KNOWN_PERSONAL_CALLS = new Set([
  'GET /api/trips/active',          // главная: блок «активная поездка», гостю тихо не показывается
  'PATCH /api/trips/X',             // планер: сохранение поездки — под входом
  'POST /api/trips',                // планер: создание поездки
  'POST /api/trips/X/share',        // планер: ссылка на поездку
  'GET /api/tourist/wishlist',      // избранное
  'POST /api/tourist/wishlist',
  'DELETE /api/tourist/wishlist',
  'POST /api/push/subscribe',       // push-подписка привязана к аккаунту
  'DELETE /api/push/subscribe',
  'POST /api/chat/conversations',   // чат с оператором — под входом
  'POST /api/reviews/photo',        // отзыв пишет вошедший
  'POST /api/reviews/tour/X',
  'POST /api/places/X/reviews',
  'POST /api/places/X/photos',      // фото места: форма сама спрашивает вход (PhotoUpload)
  'GET /api/referral/my-code',      // реферальный код вошедшего
  'POST /api/accommodations/X/book',// бронь жилья — форма гейтится
  'GET /api/accommodations/X/prices',
  'POST /api/tools/equipment',      // AI-подбор снаряжения: rate-limit есть, вход пока обязателен
  'POST /api/tools/safety',
  'POST /api/tools/X',
  'POST /api/bookings/tour',        // оплата тура — requireAuth в хендлере
  'POST /api/gear/rentals',         // аренда снаряжения — requireAuth в хендлере
  'GET /api/chat/conversations',    // чат-виджет не рендерится без входа
  'GET /api/chat/unread',
  'POST /api/chat/conversations/X/read',
  'POST /api/chat/conversations/X/messages',
]);

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
}

interface Call { file: string; key: string }

function collectCalls(): Call[] {
  const files: string[] = [];
  walk(join(ROOT, 'app'), files);
  walk(join(ROOT, 'components'), files);
  walk(join(ROOT, 'hooks'), files);

  const calls: Call[] = [];
  for (const f of files) {
    if (PROTECTED_PREFIXES.some(p => f.startsWith(p))) continue;
    if (PROTECTED_COMPONENT_DIRS.some(p => f.startsWith(p))) continue;
    const src = readFileSync(f, 'utf-8');
    if (!src.includes("'use client'") && !src.includes('"use client"')) continue;
    const re = /fetch\(\s*(['"`])((?:\/api)[^'"`]*)\1([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const path = m[2].replace(/\$\{[^}]+\}/g, 'X').split('?')[0];
      const tail = src.slice(m.index, m.index + 400);
      const mm = /method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(tail);
      const method = mm ? mm[1] : 'GET';
      calls.push({ file: f.replace(ROOT + '/', ''), key: `${method} ${path}` });
    }
  }
  return calls;
}

describe('Edge и клиентские fetch публичных страниц', () => {
  const calls = collectCalls();

  it('перепись вообще что-то нашла — ноль вызовов был бы отказом сканера', () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it('каждый непубличный вызов учтён как осознанный долг', () => {
    const offenders = [...new Set(
      calls
        .filter(c => {
          const [method, path] = c.key.split(' ');
          return !isPublicApiPath(path, method);
        })
        .filter(c => !KNOWN_PERSONAL_CALLS.has(c.key))
        .map(c => `${c.key}  (${c.file})`),
    )];
    expect(offenders, [
      'Клиент публичной страницы зовёт API, которое Edge режет анониму.',
      'Либо путь осознанно открывается в lib/auth/public-api-routes.ts,',
      'либо клиент обрабатывает вход и вызов вносится в KNOWN_PERSONAL_CALLS:',
      ...offenders,
    ].join('\n')).toEqual([]);
  });

  it('долг только сокращается: мёртвые записи выносятся из списка', () => {
    const live = new Set(calls.map(c => c.key));
    const stale = [...KNOWN_PERSONAL_CALLS].filter(k => !live.has(k));
    expect(stale, `В KNOWN_PERSONAL_CALLS остались записи без живых вызовов: ${stale.join(', ')}`)
      .toEqual([]);
  });
});
