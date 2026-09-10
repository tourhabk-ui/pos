/**
 * Прогулка туристом 10.09 — сторож UX-находок (#1779, #1780).
 *
 * Держится форма кода: что первым на экране SOS, откуда берутся цифры витрины,
 * какая вкладка открывается по адресу /routes, как называется платформа на
 * входе, где стоят плавающие кнопки и как шапка узнаёт о входе. Каждая строка
 * здесь — возврат конкретной находки, а не вкус.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('экран SOS: позвонить — первым (#1779)', () => {
  const src = read('app/sos/page.tsx');

  it('кнопка «Позвонить 112» стоит раньше координат, QR и меша', () => {
    const call = src.indexOf('Позвонить {PRIMARY.phone}');
    const coords = src.indexOf('Ваши координаты');
    const qr = src.indexOf('{qrSvg && coords && (');
    const mesh = src.indexOf('<MeshStatusWidget');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(coords);
    expect(coords).toBeLessThan(qr);
    expect(coords).toBeLessThan(mesh);
  });

  it('эстафета, меш и сканер — под заголовком «Если связи нет» после номеров', () => {
    const numbers = src.indexOf('Другие службы');
    const section = src.indexOf('Если связи нет');
    const scanner = src.indexOf('<SosQrScanner />');
    expect(numbers).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(numbers);
    expect(scanner).toBeGreaterThan(section);
  });

  it('главный номер берётся из единого источника, а не дублируется списком', () => {
    expect(src).toMatch(/EMERGENCY_PRIMARY/);
    expect(src).toMatch(/SOS_CONTACTS\.filter\(\(c\) => !c\.primary\)/);
  });

  it('серверное «уведомления не настроены» туристу не показывается', () => {
    expect(read('components/PWA/PushSafetyOffer.tsx')).toMatch(/<PushSubscribeButton audience="tourist" \/>/);
    const btn = read('components/PWA/PushSubscribeButton.tsx');
    expect(btn).toMatch(/audience === 'tourist'/);
    // Не молча: состояние уходит в консоль (§4.0).
    expect(btn).toMatch(/console\.warn\('\[PushSubscribeButton\] push не настроен/);
  });
});

describe('честные цифры витрины и главной (#1780)', () => {
  it('каталог: герой и сводка считаются по живым турам, констант нет', () => {
    const src = read('components/marketplace/MarketplaceClient.tsx');
    expect(src).not.toMatch(/<Mountain className="w-3 h-3" \/>\s*13 туров/);
    expect(src).not.toMatch(/value: '8'/);
    expect(src).not.toMatch(/value: '2\+'/);
    expect(src).not.toMatch(/value: '100%'/);
    expect(src).toMatch(/fetch\('\/api\/hub\/marketplace\/tours\?limit=100'\)/);
    expect(src).toMatch(/directions: new Set\(allTours\.map\(t => t\.activity_type\)/);
    expect(src).toMatch(/operators: new Set\(allTours\.map\(t => t\.operator_id\)/);
    // Плитка без туров не нажимается.
    expect(src).toMatch(/disabled=\{empty\}/);
  });

  it('главная: подписи склоняются, «рег. МЧС» и «SAR» раскрыты словами', () => {
    const data = read('app/_home/data.ts');
    expect(data).not.toMatch(/label: 'маршрута'/);
    expect(data).not.toMatch(/label: 'локация'/);
    expect(data).not.toMatch(/label: 'рег\. МЧС'/);
    expect(data).not.toMatch(/label: 'SAR'/);
    expect(data).toMatch(/plural\(counts\.routes, 'маршрут', 'маршрута', 'маршрутов'\)/);
    const band = read('components/homepage/StatsBand.tsx');
    expect(band).toMatch(/plural\(stats\.safetyProfiles, 'профиль', 'профиля', 'профилей'\)/);
    expect(band).not.toMatch(/SAR-мониторинг/);
  });
});

describe('навигация и именование (#1780)', () => {
  it('/routes по умолчанию открывает маршруты — на сервере и на клиенте', () => {
    expect(read('app/routes/page.tsx')).toMatch(/kindRaw === 'place' \? 'place' : 'route'/);
    const client = read('app/routes/_RoutesPageClient.tsx');
    expect(client).toMatch(/\(k === 'place' \|\| k === 'route'\) \? k : 'route'/);
    expect(client).not.toMatch(/if \(kind !== 'place'\)\s+p\.set\('kind'/);
  });

  it('/register говорит, что это МЧС, и ведёт к регистрации аккаунта', () => {
    const src = read('app/register/page.tsx');
    expect(src).toMatch(/маршрут в МЧС/);
    expect(src).toMatch(/href="\/auth\/login\?mode=register"/);
    expect(read('app/auth/login/_AuthPageClient.tsx')).toMatch(/get\('mode'\) === 'register'/);
  });

  it('страница входа брендирована как Ведар, без старого логотипа', () => {
    const src = read('app/auth/login/_AuthPageClient.tsx');
    expect(src).not.toMatch(/Kamchatour Hub/);
    expect(src).not.toMatch(/logo-kamchatka\.svg/);
    expect(src).toMatch(/<Logo size=\{40\} \/>/);
    expect(src).toMatch(/>Ведар</);
  });

  it('/return без параметра объясняет экран, а не говорит «не найден»', () => {
    const src = read('app/return/ReturnClient.tsx');
    expect(src).toMatch(/if \(!registrationId\) \{/);
    expect(src).toMatch(/Отметка о возвращении/);
  });
});

describe('тач-цели и плавающие кнопки (#1780)', () => {
  it('иконки шапки — 44px, пилюля обстановки на главной — не ниже 44px', () => {
    const header = read('components/layout/Header.tsx');
    expect(header).toMatch(/width: '44px',\s*height: '44px'/);
    expect(read('app/_home/_HomeV8Client.tsx')).toMatch(/\.v7 \.pill\{[^}]*min-height:44px/);
  });

  it('кнопка заявки скрыта на /kuzmich (там живой чат) и на входе', () => {
    const src = read('components/shared/StickyLeadButton.tsx');
    expect(src).toMatch(/'\/kuzmich', '\/auth'\]/);
  });

  it('фильтры карты на телефоне — одна прокручиваемая строка, чипы 44px', () => {
    const src = read('app/map/_MapPageClient.tsx');
    expect(src).toMatch(/flex flex-nowrap md:flex-wrap gap-2/);
    expect(src).toMatch(/min-h-\[44px\] px-3 py-2 rounded-lg text-sm font-medium/);
  });
});

describe('мелочи кода (#1780)', () => {
  it('шапка спрашивает /api/auth/state (200 у гостя), а не /api/auth/me (401)', () => {
    expect(read('components/layout/Header.tsx')).toMatch(/fetch\('\/api\/auth\/state'/);
    expect(read('components/layout/Header.tsx')).not.toMatch(/fetch\('\/api\/auth\/me'/);
    expect(existsSync(join(process.cwd(), 'app/api/auth/state/route.ts'))).toBe(true);
    const route = read('app/api/auth/state/route.ts');
    expect(route).toMatch(/authenticated: false/);
    expect(route).not.toMatch(/status: 401/);
  });

  it('слоты тура читают params через await', () => {
    const src = read('app/api/tours/[id]/slots/route.ts');
    expect(src).toMatch(/params: Promise<\{ id: string \}>/);
    expect(src).toMatch(/const \{ id \} = await params;/);
  });

  it('карточка маршрута декодирует slug из адреса', () => {
    const src = read('app/routes/[id]/page.tsx');
    expect(src).toMatch(/function decodeSlug\(raw: string\)/);
    expect(src).toMatch(/getRoute\(decodeSlug\(id\)\)/);
    expect(src).not.toMatch(/await getRoute\(id\)/);
  });
});
