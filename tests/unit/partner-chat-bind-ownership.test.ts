/**
 * Сторож: адрес партнёра в мессенджере назначает только тот, чьё право
 * проверено (09.10).
 *
 * `partners.telegram_chat_id` и `partners.max_chat_id` решают, куда уходят
 * имена и телефоны туристов из новых броней (`sendPdAlert` через
 * `reachForPartner`) и кому помощник оператора рассказывает о бронях
 * (`findOperatorByChatId`). До 09.10 команда боту «/partner EMAIL»
 * («партнер EMAIL» в MAX) находила партнёра по `contact->>'email'` и молча
 * переписывала его адрес на того, кто прислал команду. Почта партнёра — не
 * секрет: она на его сайте и в визитках. Правило владельца 29.09
 * (`lib/partners/channel-link.ts`) этот путь нарушал с первого дня.
 *
 * Держится связка: каждый файл, который пишет в эти колонки, назван здесь с
 * тем, чем доказано право писать. Новый писатель краснеет, пока не назван;
 * запись о файле, который писать перестал, — тоже (список самоустаревает).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Файл → чем доказано право назначить адрес. */
const CHAT_WRITERS: Readonly<Record<string, string>> = {
  'lib/partners/bind-channel.ts':
    'ссылка op_ подписана HMAC без запасного секрета; выдаёт её администратор (requireAdmin) или сам партнёр после входа на свою карточку (requirePartner, решение 09.10); срок 72 часа; перепривязку видят администратор и прежний чат',
  'app/api/admin/operators/[id]/contacts/route.ts':
    'правка карточки партнёра администратором (requireAdmin)',
  'app/api/hub/operator/profile/route.ts':
    'оператор правит СВОЙ профиль после входа (requireOperator, строка партнёра по его user_id)',
  'app/api/telegram/webhook/route.ts':
    '/start link_ — токен HMAC, выданный вошедшему пользователю (/api/telegram/connect, requireAuth); пишется по его user_id',
  'app/api/auth/telegram/route.ts':
    'вход через Telegram Login Widget с проверкой подписи Telegram; пишется по user_id вошедшего',
};

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const rel = `${dir}/${n}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx|js)$/.test(n) ? [rel] : [];
  });
}

/**
 * Пишет адрес: есть `UPDATE partners` и присваивание колонке адреса — в SQL
 * (`telegram_chat_id = $1`, `= CASE …`) или через построитель полей
 * (`p('telegram_chat_id', …)`). Сравнение в WHERE (`WHERE telegram_chat_id =
 * $1`) — чтение; поэтому присваивание ищется после SET.
 */
function writesChat(src: string): boolean {
  if (!/UPDATE\s+partners\b/.test(src)) return false;
  if (/\bp\(\s*'(telegram_chat_id|max_chat_id)'/.test(src)) return true;
  return [...src.matchAll(/UPDATE\s+partners\b[\s\S]*?\bSET\b([\s\S]*?)(\bWHERE\b|`)/g)]
    .some((m) => /\b(telegram_chat_id|max_chat_id)\s*=/.test(m[1]));
}

const files = [...walk('app'), ...walk('lib'), ...walk('scripts')];
const writers = files.filter((f) => writesChat(read(f)));

describe('адрес партнёра в мессенджере назначает только проверенный', () => {
  it('поиск писателей работает: находит заведомого (bind-channel)', () => {
    expect(writers).toContain('lib/partners/bind-channel.ts');
  });

  it('каждый писатель назван с тем, чем доказано право', () => {
    const unnamed = writers.filter((f) => !(f in CHAT_WRITERS));
    expect(unnamed, 'новый писатель адреса партнёра — назови, чем доказано право писать').toEqual([]);
    for (const [f, why] of Object.entries(CHAT_WRITERS)) {
      expect(why.length, f).toBeGreaterThan(30);
      expect(writers, `${f}: больше не пишет адрес — убрать запись`).toContain(f);
    }
  });

  it('ни один писатель не ищет партнёра по почте', () => {
    for (const f of writers) {
      expect(read(f), f).not.toMatch(/contact(?:s)?->>'email'\)?\s*=/);
    }
  });

  it('команда «/partner EMAIL» отвечает, как подключиться, и ничего не пишет', () => {
    const chat = read('lib/kuzmich/operator-chat.ts');
    expect(chat).not.toMatch(/registerOperator(Max)?ChatId/);
    expect(chat).not.toMatch(/UPDATE\s+partners/);
    expect(chat).toMatch(/export const PARTNER_EMAIL_BIND_CLOSED/);
    for (const bot of ['app/api/telegram/kuzmich/route.ts', 'app/api/max/kuzmich/route.ts']) {
      expect(read(bot), bot).toMatch(/PARTNER_EMAIL_BIND_CLOSED/);
      expect(read(bot), bot).not.toMatch(/registerOperator(Max)?ChatId/);
    }
  });

  it('инструкция оператора не учит подключаться по почте', () => {
    const help = read('app/hub/operator/help/_OperatorHelpClient.tsx');
    expect(help).not.toMatch(/partner ваш@email|\/partner email/i);
    expect(help).toMatch(/\/hub\/operator\/profile/);
  });
});
