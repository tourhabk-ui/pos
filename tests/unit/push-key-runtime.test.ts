/**
 * Ключ VAPID приходит во время выполнения, а кнопка не исчезает молча.
 *
 * 05.09 владелец с установленной PWA не нашёл, где включить уведомления,
 * при ключах, заданных на сервере (Watchdog это подтверждал). Кнопка читала
 * NEXT_PUBLIC_VAPID_KEY из сборки; Dockerfile ключ в сборку не передаёт, и
 * с пустой строкой кнопка считала push «не поддержанным» и возвращала null —
 * пустое место вместо диагноза. Судим код, а не прозу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const BUTTON = strip(read('components/PWA/PushSubscribeButton.tsx'));
const ROUTE = strip(read('app/api/push/vapid-public-key/route.ts'));
const REGISTRY = strip(read('lib/auth/public-api-routes.ts'));
const SOS = strip(read('app/sos/page.tsx'));

describe('ключ спрашивается у сервера, сборочный — запасной', () => {
  it('роут отдаёт ключ и честный configured', () => {
    expect(ROUTE).toMatch(/process\.env\.NEXT_PUBLIC_VAPID_KEY/);
    expect(ROUTE).toMatch(/key: key \|\| null/);
    expect(ROUTE).toMatch(/configured: !!key && privateSet/);
  });

  it('роут открыт Edge-гейтом — иначе гость получит 401 до хендлера', () => {
    expect(REGISTRY).toMatch(/'\/api\/push\/vapid-public-key':\s*\['GET'\]/);
  });

  it('кнопка ходит за ключом во время выполнения и подписывается им', () => {
    expect(BUTTON).toMatch(/fetch\('\/api\/push\/vapid-public-key'/);
    expect(BUTTON).toMatch(/applicationServerKey: urlB64ToUint8Array\(vapidKey\)/);
    expect(BUTTON).not.toMatch(/urlB64ToUint8Array\(VAPID_PUBLIC_KEY\)/);
  });
});

describe('кнопка не исчезает молча', () => {
  it('«не поддержано» и «не настроено» — разные состояния и оба видимы', () => {
    expect(BUTTON).toMatch(/'unsupported' \| 'unconfigured'/);
    expect(BUTTON).not.toMatch(/state === 'unsupported'\) return null/);
    expect(BUTTON).toContain('Этот браузер не умеет push-уведомления');
    expect(BUTTON).toContain('Уведомления не настроены на сервере');
  });

  it('пустой ключ от сервера ведёт в unconfigured, а не в unsupported', () => {
    expect(BUTTON).toMatch(/if \(!key\) \{ setState\('unconfigured'\); return; \}/);
  });
});

describe('предложение стоит и на экране SOS', () => {
  it('/sos рендерит общий компонент PushSafetyOffer', () => {
    expect(SOS).toMatch(/<PushSafetyOffer \/>/);
    expect(SOS).toMatch(/import \{ PushSafetyOffer \} from '@\/components\/PWA\/PushSafetyOffer'/);
  });
});
