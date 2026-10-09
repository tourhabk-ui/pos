/**
 * Сторож баннера «подключите MAX или Telegram» (CRM 1в-3, #2325).
 *
 * «Подключён» на экране обязан значить то же, что «дойдёт» в доставке:
 * баннер спрашивает `/api/hub/crm/channel`, а тот — `reachForPartner`, по
 * которому шлют заявки и напоминания. Прежний баннер оператора смотрел одну
 * колонку (users.telegram_id) и звал подключать Telegram того, кому заявки
 * уже приходили в MAX. Сбой проверки — не «не подключено» (§4.0).
 * И связка с подключением: Telegram, привязанный ссылкой из кабинета,
 * ложится в карточку партнёра у всех шести ролей, а не только у оператора
 * и гида — иначе баннер погас бы, а бронь жилья по-прежнему не доходила бы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const requirePartner = vi.fn();
const reachForPartner = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reachForPartner(...a) }));

const route = await import('@/app/api/hub/crm/channel/route');
const req = () => new NextRequest('http://localhost/api/hub/crm/channel');

beforeEach(() => {
  requirePartner.mockReset().mockResolvedValue({ outcome: 'ok', partnerId: 'p-1', category: 'stay', userId: 'u-1' });
  reachForPartner.mockReset();
});

describe('GET /api/hub/crm/channel', () => {
  it('не партнёр — ответ гарда, адреса не читаются', async () => {
    requirePartner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await route.GET(req())).status).toBe(403);
    expect(reachForPartner).not.toHaveBeenCalled();
  });

  it('отвечает «есть / нет», а не сами адреса; партнёр — из гарда', async () => {
    reachForPartner.mockResolvedValueOnce({ telegramChatId: '111', maxChatId: null, telegramSource: 'user', reachable: true });
    const r = await route.GET(req());
    expect(reachForPartner).toHaveBeenCalledWith('p-1');
    const body = await r.json();
    expect(body.data).toEqual({ reachable: true, max: false, telegram: true });
    expect(JSON.stringify(body)).not.toMatch(/111/);
  });

  it('не смогли прочитать — 503, а не «не подключено»', async () => {
    reachForPartner.mockResolvedValueOnce(null);
    expect((await route.GET(req())).status).toBe(503);
  });
});

describe('баннер в шести кабинетах', () => {
  const CABINETS = ['operator', 'guide', 'carrier', 'stay', 'gear', 'agent'] as const;

  for (const cab of CABINETS) {
    it(`${cab}: баннер смонтирован`, () => {
      const layout = read(`app/hub/${cab}/layout.tsx`);
      expect(layout).toMatch(/import \{ PartnerChannelBanner \} from '@\/components\/hub\/PartnerChannelBanner'/);
      expect(layout).toMatch(/<PartnerChannelBanner \/>/);
    });
  }

  it('баннер по одной колонке ушёл, а не остался рядом', () => {
    expect(existsSync(join(ROOT, 'components/operator/TelegramConnectBanner.tsx'))).toBe(false);
    expect(read('app/hub/operator/layout.tsx')).not.toMatch(/OperatorTelegramBanner/);
  });

  it('спрашивает правило доставки и молчит, пока ответа нет или он «подключён»', () => {
    const banner = read('components/hub/PartnerChannelBanner.tsx');
    expect(banner).toMatch(/fetch\('\/api\/hub\/crm\/channel'/);
    expect(banner).toMatch(/if \(!channel \|\| channel\.reachable \|\| dismissed\) return null;/);
    expect(read('app/api/hub/crm/channel/route.ts')).toMatch(/reachForPartner\(ctx\.partnerId\)/);
  });
});

describe('Telegram из кабинета — в карточку партнёра у всех ролей', () => {
  const hook = read('app/api/telegram/webhook/route.ts');

  it('роли записи — все партнёрские, а не оператор и гид', () => {
    expect(hook).toMatch(/const PARTNER_CHAT_ROLES: ReadonlySet<string> = new Set\(\[\.\.\.PARTNER_ROLES, 'transfer_operator'\]\)/);
    expect(hook).toMatch(/if \(PARTNER_CHAT_ROLES\.has\(role\)\) \{\s*await query\(\s*`UPDATE partners SET telegram_chat_id = \$1 WHERE user_id = \$2`/);
    expect(hook).not.toMatch(/role === 'operator' \|\| role === 'guide'/);
    expect(PARTNER_ROLES.length).toBe(6);
  });

  it('отказ записи не глушится', () => {
    const block = hook.slice(hook.indexOf('PARTNER_CHAT_ROLES.has(role)'), hook.indexOf('sendWelcomeMessage(userId'));
    expect(block).not.toMatch(/\.catch\(\(\) => null\)/);
    expect(block).toMatch(/console\.error\('\[telegram\/link\]/);
  });
});
