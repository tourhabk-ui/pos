/**
 * Вход на сайт через мессенджер для карточки партнёра (владелец 26.10: прокатчику
 * «Лагуны» нужен кабинет на сайте, почты у человека нет, MAX есть).
 *
 * Кто станет владельцем карточки — не выбирает администратор и не вводит руками:
 * это человек, открывший ссылку подключения op_ в личном диалоге
 * (`partners.max_owner_user_id` / `telegram_owner_user_id`, миграция 1336). Ссылку
 * выдал администратор, тот же человек уже получает заявки карточки в чат —
 * вход на сайт расширяет его кабинет, а не выдаёт чужой.
 *
 * Одной транзакцией:
 *  - аккаунт с этим max_user_id / telegram_id находится или заводится. Пароля у
 *    него нет: вход только через мессенджер («Войти через MAX» находит аккаунт
 *    по max_user_id). Согласие на ПД не записывается — его даёт сам человек,
 *    администратор за него не может (pd-guard §6);
 *  - найденный аккаунт туриста получает роль карточки — активной и в списке
 *    своих ролей (preferences.roles, как у POST /api/roles). Аккаунт, у которого
 *    среди своих ролей есть другая, кроме туриста (администратор, другой
 *    партнёр), не перекрашивается молча — отказ;
 *  - карточка получает владельца, только если владельца не было.
 *
 * Телефон и почта человека здесь не нужны и не пишутся.
 */
import type { PoolClient } from 'pg';
import { isPartnerCategory, type PartnerCategory } from '@/lib/partners/categories';
import { ownedRoles } from '@/lib/auth/role-switch';

export type MessengerLoginOutcome =
  | { outcome: 'linked'; via: 'max' | 'telegram'; created: boolean; role: PartnerCategory }
  | { outcome: 'not_found' }
  | { outcome: 'has_account' }
  | { outcome: 'no_role'; category: string }
  | { outcome: 'no_opener' }
  | { outcome: 'other_role'; role: string }
  | { outcome: 'owns_other_card' };

/** Текст отказа для администратора — по исходу. */
export const MESSENGER_LOGIN_REFUSAL: Record<Exclude<MessengerLoginOutcome['outcome'], 'linked'>, string> = {
  not_found: 'Карточка партнёра не найдена',
  has_account: 'У карточки уже есть аккаунт: вход на сайт заведён раньше.',
  no_role: 'Для этой категории карточки кабинета на сайте нет.',
  no_opener: 'Сначала владелец должен открыть ссылку подключения этой карточки в MAX или Telegram (в личном чате с ботом). После этого нажмите кнопку снова.',
  other_role: 'Аккаунт этого человека уже с другой ролью (администратор или другой партнёр) — менять её молча нельзя.',
  owns_other_card: 'Этот человек уже владелец другой карточки — вторую к нему не привязываем.',
};

interface CardRow {
  name: string;
  category: string;
  user_id: string | null;
  max_owner_user_id: string | null;
  telegram_owner_user_id: string | null;
}

interface UserRow {
  id: string;
  role: string;
  preferences: { roles?: unknown } | null;
}

/**
 * Завести вход через мессенджер. Зовётся внутри открытой транзакции клиента
 * (BEGIN/COMMIT — у вызывающего): отказ — ROLLBACK вызывающего, запись — его
 * COMMIT.
 */
export async function linkMessengerLogin(client: Pick<PoolClient, 'query'>, partnerId: string): Promise<MessengerLoginOutcome> {
  const { rows: [card] } = await client.query<CardRow>(
    `SELECT name, category, user_id::text AS user_id,
            max_owner_user_id::text AS max_owner_user_id,
            telegram_owner_user_id::text AS telegram_owner_user_id
       FROM partners WHERE id = $1::uuid FOR UPDATE`,
    [partnerId],
  );
  if (!card) return { outcome: 'not_found' };
  if (card.user_id) return { outcome: 'has_account' };
  if (!isPartnerCategory(card.category)) return { outcome: 'no_role', category: card.category };
  const role = card.category;

  const via: 'max' | 'telegram' | null = card.max_owner_user_id ? 'max' : card.telegram_owner_user_id ? 'telegram' : null;
  if (via === null) return { outcome: 'no_opener' };
  const messengerId = via === 'max' ? card.max_owner_user_id! : card.telegram_owner_user_id!;
  const idColumn = via === 'max' ? 'max_user_id' : 'telegram_id';

  const { rows: [existing] } = await client.query<UserRow>(
    `SELECT id::text AS id, role, preferences FROM users WHERE ${idColumn} = $1::bigint FOR UPDATE`,
    [messengerId],
  );

  let userId: string;
  let created = false;
  if (existing) {
    const foreign = ownedRoles(existing.preferences?.roles, existing.role).find((r) => r !== role && r !== 'tourist');
    if (foreign) return { outcome: 'other_role', role: foreign };
    // Любая его карточка, какой бы категории ни была: вторую к человеку не привязываем.
    const { rows: [own] } = await client.query<{ owns: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM partners WHERE user_id = $1::uuid) AS owns`,
      [existing.id],
    );
    if (own?.owns === true) return { outcome: 'owns_other_card' };
    const roles = [...new Set([...ownedRoles(existing.preferences?.roles, existing.role), role])];
    await client.query(
      `UPDATE users
          SET role = $2,
              preferences = jsonb_set(
                CASE WHEN jsonb_typeof(preferences) = 'object' THEN preferences ELSE '{}'::jsonb END,
                '{roles}', $3::jsonb),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [existing.id, role, JSON.stringify(roles)],
    );
    userId = existing.id;
  } else {
    // Адрес-заглушка того же вида, что заводят входы через MAX и Telegram
    // (app/api/auth/max/status, app/api/auth/telegram): почты у человека нет.
    const email = via === 'max' ? `max_${messengerId}@max.local` : `tg_${messengerId}@telegram.local`;
    const { rows: [inserted] } = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, role, ${idColumn}, password_hash, is_active, pd_consent_given, preferences)
       VALUES ($1, $2, $3::text, $4::bigint, '', TRUE, FALSE, jsonb_build_object('roles', jsonb_build_array($3::text)))
       RETURNING id::text AS id`,
      [email, card.name, role, messengerId],
    );
    userId = inserted.id;
    created = true;
  }

  await client.query(
    `UPDATE partners SET user_id = $2::uuid, updated_at = NOW() WHERE id = $1::uuid AND user_id IS NULL`,
    [partnerId, userId],
  );
  return { outcome: 'linked', via, created, role };
}
