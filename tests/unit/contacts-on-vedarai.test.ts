/**
 * Контакты — на vedarai.ru (решение владельца 26.09: «адрес везде vedarai.ru»).
 * С 05.10 почта — pospk@mail.ru: ящика на vedarai.ru ещё нет (см. тест ниже).
 *
 * До этого дня сайт давал туристам и партнёрам два десятка адресов на
 * прежнем домене (support@, privacy@, legal@, finance@ tourhab.ru, старый
 * kamhub.ru, Telegram @tourhab_support) — в реквизитах, юридических
 * документах, письмах и справке, — а футер, /about и разметка сайта уже
 * говорили info@vedarai.ru. Два ответа на «куда писать» — это ни одного.
 *
 * Сознательно НЕ в этом правиле — адрес ОТПРАВИТЕЛЯ писем и страница
 * настройки ящиков: отправитель привязан к SMTP-ящику, и смена в коде без
 * ящика на vedarai.ru оборвала бы всю почту. Это отдельное решение, оно
 * названо в ALLOWED.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { REQUISITES } from '@/lib/legal/requisites';
import { SUPPORT } from '@/lib/help/content';

/** Файл → почему в нём ещё можно встретить прежний домен. */
const ALLOWED: Record<string, string> = {
  'lib/config.ts': 'умолчание EMAIL_FROM — адрес отправителя, привязан к SMTP-ящику',
  'lib/email.ts': 'умолчание SMTP_FROM — адрес отправителя',
  'app/hub/admin/email/_EmailAdminClient.tsx': 'инструкция по ящикам SMTP: меняется вместе с ящиками',
  'app/api/admin/auth/issue-token/route.ts': 'служебный email внутреннего токена, людям не показывается',
  'lib/analytics/bot-detect.ts': 'прежний хост — свой, а не внешний источник переходов',
  'app/api/admin/analytics/traffic/route.ts': 'комментарий о прежнем хосте',
};

describe('контакты на vedarai.ru', () => {
  it('реквизиты и справка дают один адрес', () => {
    expect(REQUISITES.emailSupport).toBe(SUPPORT.email);
    expect(REQUISITES.emailPrivacy).toBe(SUPPORT.email);
  });

  it('ящика info@vedarai.ru нет — адрес не обещается нигде (решение владельца 05.10)', () => {
    // Владелец 05.10: «я пока не заводил в Timeweb ящик». Письма на
    // info@vedarai.ru уходили в никуда — в том числе запросы субъектов ПД.
    // До создания ящика контакт — pospk@mail.ru (тот же, что в уведомлении
    // Роскомнадзору). Заведут ящик — вернуть адрес одной заменой.
    expect(SUPPORT.email).toBe('pospk@mail.ru');
    const out = execSync(
      "git grep -l 'info@vedarai\\.ru' -- app components lib public || true",
      { encoding: 'utf-8' },
    );
    const files = out.split('\n').filter(Boolean)
      // Приёмник платежей — зона §7 «не трогать»; оплата выключена, письмо не уходит.
      .filter((f) => f !== 'app/api/payments/webhook/route.ts');
    expect(files, `несуществующий ящик в: ${files.join(', ')}`).toEqual([]);
  }, 20_000); // git grep по дереву: под полным прогоном 5 с не хватало

  it('прежних адресов нет нигде, кроме названных исключений', () => {
    const out = execSync(
      "git grep -lE 'tourhab\\.ru|@tourhab_support|kamhub\\.ru' -- app components lib public || true",
      { encoding: 'utf-8' },
    );
    const files = out.split('\n').filter(Boolean);
    const offenders = files.filter((f) => !(f in ALLOWED));
    expect(offenders, `прежний домен в: ${offenders.join(', ')}`).toEqual([]);
  });
});
