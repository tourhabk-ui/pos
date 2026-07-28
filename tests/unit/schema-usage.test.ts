/**
 * База должна объявлять то, что код в неё пишет.
 *
 * Сверка INSERT'ов с объявленной схемой (lib/database/schema.sql + migrations/)
 * выросла из живого случая: `INSERT INTO bookings` падал на разборе при каждом
 * вызове, потому что `bookings` — VIEW без половины этих колонок. Тот же приём,
 * применённый ко всей кодовой базе, показал, что случай не единичный.
 *
 * Самое неприятное всплыло рядом: миграция 080 строит индекс по
 * `users(telegram_id)` — колонке, которой не объявлял НИ ОДИН файл схемы. На
 * чистой базе цепочка миграций падает там. Значит репозиторий не мог собрать
 * собственную БД, а на проде это проходило только потому, что колонку когда-то
 * добавили руками мимо миграций — ровно то, что CLAUDE.md запрещает. Пока так,
 * «миграции применяются автоматически при деплое» даёт ложное спокойствие:
 * любой новый инстанс поднимается сломанным.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseDeclaredSchema, findUndeclaredWrites, findUndeclaredUpdates, flatten } from '@/lib/db/schema-usage';

const ROOT = process.cwd();

const SQL_FILES = [
  readFileSync(join(ROOT, 'lib/database/schema.sql'), 'utf-8'),
  ...readdirSync(join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf-8')),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...walk('app'), ...walk('lib')].map((path) => ({
  path,
  src: readFileSync(join(ROOT, path), 'utf-8'),
}));

const schema = parseDeclaredSchema(SQL_FILES);
const found = flatten(findUndeclaredWrites(SOURCES, schema));
const foundUpdates = flatten(findUndeclaredUpdates(SOURCES, schema));

/**
 * Остаток расхождения на момент постановки сторожа. Список закрыт: он может
 * только сокращаться. Чинить его весь одним заходом нельзя — для части колонок
 * тип не выводится из кода однозначно (`ai_actions_log.*`, `lead_proposals.*`), а угадывать тип в схеме безопасности хуже, чем оставить
 * долг названным. Разбирается отдельными правками по доменам.
 */
const KNOWN_GAPS = [
  'agent_approvals.agent_id',
  'ai_actions_log.agent_id',
  'ai_actions_log.agent_name',
  'ai_actions_log.details',
  'ai_actions_log.result',
  'ai_actions_log.status',
  'assets.bytes',
  'assets.key',
  'assets.mime',
  'assets.source_url',
  'lead_proposals.bear_risks',
  'lead_proposals.bull_signals',
  'lead_proposals.call_strategy',
  'lead_proposals.conversion_prob',
  'lead_proposals.recommended_action',
  'lead_proposals.verdict_urgency',
  'operator_settings.i',
  'operator_tours.created_via',
  'tour_availability.is_available',
];

describe('код пишет только в объявленные колонки', () => {
  it('новых расхождений схемы и кода не появляется', () => {
    const fresh = found.filter((f) => !KNOWN_GAPS.includes(f));
    expect(
      fresh,
      'колонку надо объявить миграцией (ADD COLUMN IF NOT EXISTS) и в lib/database/schema.sql',
    ).toEqual([]);
  });

  it('список долга не протухает', () => {
    // Починенная строка обязана быть удалена, иначе список станет кладбищем,
    // в котором незаметно спрячется новое расхождение.
    const stale = KNOWN_GAPS.filter((g) => !found.includes(g));
    expect(stale, 'расхождение устранено — убрать строку из списка').toEqual([]);
  });
});

/**
 * То же для UPDATE. Список пуст — и это стоило одного факта.
 *
 * Сервис уведомлений работал с колонкой `payload`, которой нет ни в одном файле
 * схемы. Переписывать живой сервис по одному чтению кода было нельзя, поэтому
 * расхождение ждало ответа `/api/cron/schema-audit`. Аудит 28.07 показал форму
 * боевой таблицы: `title` и `message` — отдельные NOT NULL, `data` — jsonb,
 * `payload` нет, строк в таблице 0 за всё время существования. Ноль строк —
 * потому что INSERT падал, а `catch` возвращал выдуманный объект с новым UUID.
 * Сервис переписан на настоящие колонки.
 */
const KNOWN_UPDATE_GAPS: string[] = [];

describe('код меняет только объявленные колонки', () => {
  it('новых расхождений в UPDATE не появляется', () => {
    const fresh = foundUpdates.filter((f) => !KNOWN_UPDATE_GAPS.includes(f));
    expect(fresh, 'колонку надо объявить миграцией и в lib/database/schema.sql').toEqual([]);
  });

  it('список долга по UPDATE не протухает', () => {
    const stale = KNOWN_UPDATE_GAPS.filter((g) => !foundUpdates.includes(g));
    expect(stale, 'расхождение устранено — убрать строку из списка').toEqual([]);
  });
});

describe('второй фактор и удаление аккаунта работают', () => {
  const users = schema.tables.get('users');

  it('колонки двухфакторной аутентификации объявлены', () => {
    // POST /api/auth/mfa/enable писал mfa_secret и получал 500: включить второй
    // фактор было нельзя вообще. В личном кабинете лежат паспорта туристов.
    for (const c of ['mfa_secret', 'mfa_enabled']) {
      expect(users?.has(c), `users.${c}`).toBe(true);
    }
  });

  it('заявку на удаление аккаунта есть куда записать', () => {
    // 152-ФЗ: право на удаление персональных данных. /api/user/delete пишет в
    // metadata момент обращения и срок — и падал.
    expect(users?.has('metadata')).toBe(true);
  });
});

describe('вход через Telegram и согласие на ПД объявлены', () => {
  const users = schema.tables.get('users');

  it('колонки, которые пишет регистрация, есть в схеме', () => {
    for (const c of ['pd_consent_given', 'pd_consent_at', 'pd_consent_ip']) {
      expect(users?.has(c), `users.${c}`).toBe(true);
    }
  });

  it('колонки телеграм-входа есть в схеме', () => {
    for (const c of ['telegram_id', 'telegram_username', 'is_active']) {
      expect(users?.has(c), `users.${c}`).toBe(true);
    }
  });

  it('telegram_id объявлен в bootstrap-схеме, а не только миграцией', () => {
    // Миграция 080 строит по нему индекс. Объяви колонку только миграцией 783 —
    // и на чистой базе цепочка упадёт на 080, не дойдя до починки.
    const bootstrap = SQL_FILES[0];
    const usersBlock = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(bootstrap)?.[1] ?? '';
    expect(usersBlock).toContain('telegram_id');
  });

  it('у telegram_id есть УНИКАЛЬНОЕ ограничение', () => {
    // Вход делает UPSERT `ON CONFLICT (telegram_id)`, а он требует именно
    // уникального индекса: обычного из миграции 080 недостаточно.
    const all = SQL_FILES.join('\n');
    expect(all).toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*users\s*\(\s*telegram_id/i);
  });
});

describe('уведомления читаются из настоящих колонок', () => {
  // Сверка INSERT/UPDATE не видит SELECT, а сломан был именно он: список
  // уведомлений выбирал `payload` и падал на разборе запроса — колокольчик
  // отдавал 500 при каждом открытии. Поэтому отдельный сторож по домену.
  // Смотрим не на файлы целиком, а на сами SQL-строки: слово `payload` вне
  // запроса — обычно тело веб-пуша или разобранный Zod'ом запрос, и запрещать
  // его незачем. Запрещена именно колонка.
  function notificationQueries(src: string): string[] {
    return src
      .split('`')
      .filter((chunk) => /\b(from|into|update)\s+notifications\b/i.test(chunk));
  }

  const TOUCHING = SOURCES.filter((f) => notificationQueries(f.src).length > 0);

  it('запросы к таблице уведомлений вообще находятся', () => {
    // Иначе сторож ниже зелен всегда, ничего не проверяя.
    expect(TOUCHING.length).toBeGreaterThan(3);
  });

  it('колонка payload больше не упоминается в запросах к notifications', () => {
    const offenders = TOUCHING
      .filter((f) => notificationQueries(f.src).some((q) => q.includes('payload')))
      .map((f) => f.path);

    expect(offenders, 'таблица notifications держит title, message и data — payload в ней нет').toEqual([]);
  });
});

describe('память разговора Кузьмича объявлена', () => {
  it('колонки, которые пишет и читает веб-чат, есть в схеме', () => {
    const chat = schema.tables.get('chat_sessions');
    for (const c of ['user_message_count', 'is_authenticated', 'interests_encrypted']) {
      expect(chat?.has(c), `chat_sessions.${c}`).toBe(true);
    }
  });
});
