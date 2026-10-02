/**
 * Публичный префикс целиком — не публичная запись (внутренний аудит 02.10).
 *
 * `/api/telegram` и `/api/max` стоят в реестре публичных путей как 'ALL':
 * вебхуки мессенджеров приходят без JWT, и Edge обязан их пропустить. Но
 * префикс пропускает и ВСЁ, что под ним заведут. Так `/api/telegram/rag-feedback`
 * принимал анонимную запись в базу с `user_id` из тела запроса: любой мог
 * поставить оценку ответу Кузьмича от чужого имени. Вызовов в коде у роута не
 * было ни одного — роут удалён.
 *
 * Правило: каждый пишущий обработчик под таким префиксом сверяет секрет или
 * авторизацию в САМОМ файле. Исключение записывается с причиной и
 * самоустаревает: появилась проверка — запись надо убрать.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const PREFIXES = ['app/api/telegram', 'app/api/max'];
const WRITE = /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/;
const GUARD = /secret|Secret|SECRET|verifyCronSecret|require(Admin|Auth|Role)\(|x-telegram-bot-api-secret-token|X-Telegram-Bot-Api-Secret-Token/;

/**
 * MAX-вебхук: обычные сообщения обрабатываются из любого источника, а
 * подтверждение ВХОДА требует заверенного адреса с секретом
 * (isVerifiedMaxWebhook, lib/max/webhook-url). Закрыть всё разом можно только
 * после проверки, что подписка MAX переведена на адрес с секретом, иначе
 * бот замолчит. Решение владельца, не этой правки.
 */
const KNOWN_UNGUARDED: Record<string, string> = {
  'app/api/max/kuzmich/route.ts': 'вход подтверждается только с заверенного адреса; закрыть сообщения — после проверки подписки MAX',
};

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...routes(rel));
    else if (name === 'route.ts') out.push(rel);
  }
  return out;
}

describe('пишущие роуты под публичными префиксами сверяют секрет', () => {
  const all = PREFIXES.flatMap(routes);

  it('роуты под префиксами есть — иначе сторож проверяет пустоту', () => {
    expect(all.length).toBeGreaterThan(3);
  });

  it('каждый пишущий обработчик проверяет секрет или авторизацию в файле', () => {
    const offenders = all.filter((f) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      return WRITE.test(src) && !GUARD.test(src) && !KNOWN_UNGUARDED[f];
    });
    expect(offenders, `пишущий роут без проверки под публичным префиксом: ${offenders.join(', ')}`).toEqual([]);
  });

  it('исключения самоустаревают: файл есть и проверки в нём по-прежнему нет', () => {
    for (const [f, reason] of Object.entries(KNOWN_UNGUARDED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(existsSync(join(ROOT, f)), `${f} удалён — уберите из KNOWN_UNGUARDED`).toBe(true);
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(GUARD.test(src), `${f} теперь сверяет секрет — уберите из KNOWN_UNGUARDED`).toBe(false);
    }
  });

  it('анонимной записи оценок RAG больше нет', () => {
    expect(existsSync(join(ROOT, 'app/api/telegram/rag-feedback/route.ts'))).toBe(false);
  });
});
