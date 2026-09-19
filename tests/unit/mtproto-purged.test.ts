/**
 * tests/unit/mtproto-purged.test.ts
 *
 * Чтение Telegram от имени ЛИЧНОГО аккаунта удалено и не возвращается.
 *
 * ── Решение владельца 19.09 ────────────────────────────────────────────────
 *
 * На транспорте `gramjs` (MTProto, строка сессии живого человека в переменных
 * Timeweb) висели три модуля, и ни один не работал ни дня: ключи `TG_API_ID`,
 * `TG_API_HASH`, `TG_USER_SESSION` не были заданы ни разу с заведения клиента
 * 17.05, и каждый прогон честно отвечал «MTProto не настроен».
 *
 *   Industry Intel  — девять каналов ГОСТИНИЧНОГО рынка России (Островок,
 *                     Hotelier.PRO, загородные отели). Их «market
 *                     intelligence» писался для Совета директоров, удалённого
 *                     в апреле, то есть модуль с рождения писал в никуда;
 *   Group Scout     — искал туристические группы по ключевым словам и
 *                     ВСТУПАЛ в них от имени владельца, до пяти в день;
 *   наличие мест    — читал группы операторов; писал кеш `tg_avail_*` в
 *                     agent_memory, который так и остался пустым.
 *
 * Цена хранения была не нулевой: 4.3 МБ пакета `telegram` с 44 транзитивными
 * зависимостями в сборке при лимите standalone 50 МБ (CLAUDE.md §6.1), живая
 * стадия в оркестраторе, тратившая бюджет эволюции на отказ, и постоянное
 * приглашение положить сессию личного аккаунта на сервер.
 *
 * Что осознанно ОСТАВЛЕНО — чтобы следующий чистильщик не снёс:
 *   - `lib/telegram/group-monitor.ts`: его PUSH-путь жив и кормится Bot API
 *     из вебхука (`/api/telegram/webhook`, `/api/telegram/kuzmich`). Убран
 *     только `analyzeChannelBatch` — метод существовал ради pull'а;
 *   - `searchOperatorAvailability`: ветка `tour_availability` отвечала
 *     Кузьмичу все эти месяцы и осталась единственной. Ветка чтения кеша
 *     `tg_avail_*` убрана вместе с писателем — читатель без производителя
 *     это «объявленный исход без источника» (CLAUDE.md §4);
 *   - `publicWebhookBase` / `checkAndRestoreWebhook`: Bot API, к MTProto
 *     отношения не имеют, живут в том же файле исторически;
 *   - `partners.telegram_group_url`: ссылка на группу оператора — факт о
 *     партнёре, а не зависимость от транспорта.
 *
 * Отраслевые новости при этом НЕ потеряны: Scout Digest читает публичные
 * превью `t.me/s/<канал>` через реле, без авторизации и без чужого аккаунта
 * (`lib/agents/scout-telegram.ts`).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

const GONE = [
  'lib/telegram/mtproto-client.ts',
  'lib/telegram/industry-channels.ts',
  'lib/telegram/group-scout.ts',
  'scripts/tg-auth.ts',
  'app/api/cron/industry-intel/route.ts',
  'app/api/cron/group-scout/route.ts',
  '.github/workflows/cron-group-scout.yml',
];

describe('MTProto удалён', () => {
  for (const f of GONE) {
    it(`нет файла ${f}`, () => {
      expect(existsSync(join(root, f))).toBe(false);
    });
  }

  it('пакет gramjs не значится в зависимостях', () => {
    // 4.3 МБ + 44 транзитивных пакета в standalone при лимите 50 МБ (§6.1).
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.telegram).toBeUndefined();
    expect(pkg.devDependencies?.telegram).toBeUndefined();
  });

  it('клиент MTProto не импортируется ниоткуда', () => {
    const avail = read('lib/telegram/operator-availability.ts');
    expect(avail).not.toContain('mtproto-client');
    expect(avail).not.toContain('getMTProtoClient');
  });
});

describe('стадия эволюции снята целиком, а не наполовину', () => {
  // Стадия, убранная из оркестратора, но оставленная в реестре, — это
  // «объявленный исход без источника» (§4): панель показывала бы работу,
  // которой нет. Поэтому проверяются ВСЕ места разом.
  const PLACES: Array<[string, string]> = [
    ['lib/agents/orchestrator.ts', 'industryIntel'],
    ['lib/agents/orchestrator.ts', 'scanIndustryChannels'],
    ['lib/agents/kernel/adapters/evo-run-task.ts', 'industryIntel'],
    ['lib/agents/cron-schedulers.ts', "'industry-intel': {"],
    ['lib/agents/cron-capability-registry.ts', "'industry-intel'"],
    ['lib/agents/cron-capability-registry.ts', "'group-scout'"],
    ['lib/agents/cron-registry.ts', "key: 'group-scout'"],
    ['app/hub/admin/volcano/_VolcanoClient.tsx', 'industryIntel'],
  ];

  for (const [file, needle] of PLACES) {
    it(`${file} не упоминает ${needle}`, () => {
      expect(read(file)).not.toContain(needle);
    });
  }
});

describe('живое рядом не задето', () => {
  it('Кузьмич по-прежнему спрашивает свободные места', () => {
    expect(read('lib/kuzmich/core.ts')).toContain('searchOperatorAvailability');
    const avail = read('lib/telegram/operator-availability.ts');
    expect(avail).toContain('export async function searchOperatorAvailability');
    // Источник ровно один и назван: подтверждённая операторами занятость.
    expect(avail).toContain('FROM tour_availability ta');
    // Кеша, которого никто не писал, здесь больше нет. Проверяется ЗАПРОС, а
    // не слово: имя ключа `tg_avail_*` осталось в шапке файла как история,
    // и запрещать его значило бы запрещать объяснение.
    expect(avail).not.toContain("memory_type = 'availability'");
  });

  it('watchdog вебхука на месте: он про Bot API, не про MTProto', () => {
    const avail = read('lib/telegram/operator-availability.ts');
    expect(avail).toContain('export async function checkAndRestoreWebhook');
    expect(avail).toContain('export function publicWebhookBase');
    expect(read('app/api/cron/telegram-webhook-watchdog/route.ts')).toContain('checkAndRestoreWebhook');
  });

  it('push-путь group-monitor жив, pull-метод убран', () => {
    const monitor = read('lib/telegram/group-monitor.ts');
    expect(monitor).toContain('processMessage');
    expect(monitor).not.toContain('analyzeChannelBatch');
    expect(read('app/api/telegram/webhook/route.ts')).toContain('groupMonitor');
  });

  it('отраслевые новости идут публичным превью, без чужого аккаунта', () => {
    const tg = read('lib/agents/scout-telegram.ts');
    expect(tg).toContain('t.me/s/');
    expect(tg).not.toContain('gramjs');
  });
});
