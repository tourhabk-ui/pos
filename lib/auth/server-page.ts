/**
 * Проверка роли в серверной странице хаба — до любого чтения данных.
 *
 * Зачем (аудит 15.10, находка P3-22). Edge (`middleware.ts`, §7 — не
 * трогаем) на `/hub/*` проверяет только подпись JWT; роль он сверяет лишь
 * для `/api/*`. Роль страницы хаба проверял клиентский `HubLayout` — то есть
 * ПОСЛЕ того, как сервер уже выполнил запрос страницы и положил результат в
 * RSC-пейлоад. `/hub/admin/channels` так отдавал агрегаты каналов продаж
 * любому вошедшему туристу, а соседние `safety` и `telegram/webhook` делали
 * ту же проверку руками.
 *
 * Почему в странице, а не в `layout.tsx`. При клиентской навигации Next
 * запрашивает только сегмент страницы: общий layout на сервере не
 * исполняется, и гейт в нём такой запрос не видит. Проверка стоит там, где
 * читаются данные.
 *
 * Пользователь — через `getUserFromRequest`: подпись И живая строка в
 * `user_sessions`. Выход из аккаунта отзывает сессию, и токен, утёкший после
 * выхода, страницу не откроет; сбой проверки сессии — отказ, а не «пускаем»
 * (§4.0).
 *
 * Исходы — как у клиентского гейта `HubLayout`, чтобы человек видел то же,
 * что видел раньше: не вошёл или сессия отозвана — на вход с возвратом сюда;
 * вошёл в другой роли — в свой кабинет.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromRequest, type JWTPayload } from '@/lib/auth/jwt';
import { ROLE_HUB } from '@/lib/auth/role-routes';

/**
 * Пускает дальше только пользователя одной из `allowed` ролей (по активной
 * роли токена — той же, что сверяет `requireRole` у API). Иначе — redirect,
 * который прерывает рендер страницы: код после вызова не выполняется.
 *
 * @param allowed роли, которым страница открыта (сравнение точное)
 * @param from    путь страницы — куда вернуть после входа
 */
export async function requirePageRole(allowed: readonly string[], from: string): Promise<JWTPayload> {
  const store = await cookies();
  const user = await getUserFromRequest({ cookies: { get: (name) => store.get(name) } });
  if (!user) {
    redirect(`/auth/login?from=${encodeURIComponent(from)}`);
  }
  if (!allowed.includes(user.role)) {
    redirect(ROLE_HUB[user.role] ?? '/');
  }
  return user;
}
