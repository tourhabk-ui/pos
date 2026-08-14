/**
 * Push: точный диагноз Watchdog + опт-ин на публичной /safety.
 *
 * config-check 02.08 вскрыл: VAPID-ключи заданы, но подписок 0 → 42 опасных
 * алерта в пустоту. Watchdog при этом слал общее «проверь VAPID-ключи» — и
 * ключи чинили полночи, хотя дыра была в отсутствии подписок. Причина нуля
 * подписок: кнопка жила только в /hub/tourist/notifications (за логином).
 *
 * Две правки: (1) Watchdog различает VAPID-нет / 0-подписок / доставка-падает;
 * (2) промпт подписки вынесен на публичную /safety.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const watchdog = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');
const safety = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
const subscribe = readFileSync(join(process.cwd(), 'app/api/push/subscribe/route.ts'), 'utf-8');

describe('Watchdog: точный диагноз недоставки push', () => {
  it('различает три причины, а не общее «проверь VAPID»', () => {
    expect(watchdog).toMatch(/VAPID-ключи не заданы/);
    // Проверяем, что случай «получателей нет» назван, а не как он
    // пунктуирован: прежняя привязка была к тире внутри фразы и упала бы от
    // любой переформулировки. Сторожим свойство, а не строку.
    expect(watchdog).toMatch(/подписчиков 0/);
    expect(watchdog).toMatch(/доставлять некому/);
    expect(watchdog).toMatch(/доставка не проходит/);
  });
  it('причина строится по факту: VAPID env + число подписок', () => {
    expect(watchdog).toMatch(/NEXT_PUBLIC_VAPID_KEY.*VAPID_PRIVATE_KEY/s);
    expect(watchdog).toMatch(/COUNT\(\*\)::text AS n FROM push_subscriptions/);
  });
  it('старое вводящее в заблуждение сообщение убрано', () => {
    expect(watchdog, 'вернулось общее «Проверь VAPID-ключи и подписки»')
      .not.toMatch(/Проверь VAPID-ключи и подписки\./);
  });
});

describe('Опт-ин подписки на публичной /safety', () => {
  it('кнопка подписки выведена на страницу безопасности', () => {
    expect(safety).toMatch(/import \{ PushSubscribeButton \}/);
    expect(safety).toMatch(/<PushSubscribeButton \/>/);
  });
  it('с safety-рамкой (не голая кнопка)', () => {
    expect(safety).toMatch(/Предупреждения о безопасности/);
  });
});

describe('Подписка на push доступна без логина', () => {
  // Публичная кнопка + приватный эндпоинт = аноним жмёт «Включить», браузер
  // подписывается, POST отдаёт 401, подписка не сохраняется. Ровно поэтому
  // подписок оставалось 0, хотя кнопку вынесли на /safety (02.08). Эндпоинт
  // обязан принимать анонима: user_id в схеме NULLABLE, broadcast шлёт всем.
  it('POST не заперт за requireAuth', () => {
    // Ищем именно ВЫЗОВ requireAuth(...), а не слово: в комментарии роут
    // объясняет, почему requireAuth убрали, — упоминание там законно.
    expect(subscribe, 'requireAuth() вернулся — аноним снова не сможет подписаться')
      .not.toMatch(/requireAuth\s*\(/);
    expect(subscribe, 'нет опциональной аутентификации').toMatch(/getUserFromRequest/);
  });
  it('аноним пишется как user_id NULL, а не роняет запрос', () => {
    expect(subscribe).toMatch(/auth\?\.userId\s*\?\?\s*null/);
  });
  it('повторная анонимная подписка не обнуляет ранее связанного пользователя', () => {
    expect(subscribe).toMatch(/COALESCE\(\$1, push_subscriptions\.user_id\)/);
  });
});
