// @vitest-environment node
/**
 * «Местечко Камчатка» в каталоге: карточка исполнителя (1216) и туры с фото
 * (1217), #2349.
 *
 * Держит обещания шапок миграций, которые нельзя исправить задним числом:
 *  - карточка не выдаёт себя за проверенную и за сверенную с реестром, не
 *    хранит данных людей, не создаёт пользователя, ставка записана явно;
 *  - 18 туров на карточку по slug партнёра, цена за человека, у каждого —
 *    адрес источника; три тура, где сайт противоречит сам себе в цене,
 *    заведены черновиками и называют вторую цифру в price_note;
 *  - двух туров без цены на сайте (рыбалка, хели-ски) в базе нет, и
 *    заготовка /api/admin/import-mestechko, выдумывавшая им цену, удалена;
 *  - ничего не выдумано: нет дат и сезона, нет условий отмены; описания не
 *    короче 300; программа — только где сайт её разбивает по шагам;
 *  - каждый файл фото из миграции лежит в public/images/mestechko, сжат,
 *    hero — первый снимок; оригиналы в репозитории не лежат;
 *  - вставка идемпотентна, id сравниваются текстом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractContacts, extractLegalInfo } from '@/lib/operators/profile-parse';
import { missingFields, type ReadinessRow } from '@/lib/tours/readiness';

const ROOT = process.cwd();
const CARD = readFileSync(join(ROOT, 'migrations/1216_mestechko_operator_card.sql'), 'utf-8');
const CARD_SQL = CARD.replace(/--[^\n]*/g, '');
const TOURS = readFileSync(join(ROOT, 'migrations/1217_mestechko_tours.sql'), 'utf-8');
const TOURS_SQL = TOURS.replace(/--[^\n]*/g, '');
const COVERS_SQL = readFileSync(join(ROOT, 'migrations/1221_tour_covers_brighter.sql'), 'utf-8').replace(/--[^\n]*/g, '');
/**
 * Снимки, снятые из галерей позднейшей миграцией (1221: стоковый автобус у
 * вертолётного тура — владелец 12.10). Файла в репозитории нет и быть не
 * должно: вернувшийся файл снова попал бы в галерею следующим импортом.
 */
const REMOVED = [...COVERS_SQL.matchAll(/array_remove\(photos, '(\/images\/mestechko\/[^']+)'\)/g)].map((m) => m[1]);

const SLUGS = [
  'mestechko-vulkan-gorelyy',
  'mestechko-ozero-tolmachevo',
  'mestechko-halaktyrskiy-plyazh',
  'mestechko-tolbachik-standard',
  'mestechko-avachinskiy-pereval',
  'mestechko-mys-mayachnyy',
  'mestechko-vachkazhets',
  'mestechko-dachnye-istochniki',
  'mestechko-dolina-geyzerov-tolbachik',
  'mestechko-kurilskoe-ozero',
  'mestechko-dolina-geyzerov',
  'mestechko-vertolet-tolbachik',
  'mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy',
  'mestechko-oblet-koryakskiy-avachinskiy',
  'mestechko-ostrov-starichkov',
  'mestechko-buhta-russkaya',
  'mestechko-snegohod-avachinskiy-pereval',
  'mestechko-snegohod-mys-mayachnyy',
];

/** Сайт противоречит сам себе в цене — черновики до слова оператора. */
const DRAFTS = ['mestechko-dolina-geyzerov-tolbachik', 'mestechko-ostrov-starichkov', 'mestechko-buhta-russkaya'];

/** Цены с карточек туров mestechkokam.ru, снятые 12.10.2026. */
const SITE_PRICES: Record<string, number> = {
  'mestechko-vulkan-gorelyy': 15000,
  'mestechko-ozero-tolmachevo': 14000,
  'mestechko-halaktyrskiy-plyazh': 7000,
  'mestechko-tolbachik-standard': 115000,
  'mestechko-avachinskiy-pereval': 11000,
  'mestechko-mys-mayachnyy': 10000,
  'mestechko-vachkazhets': 15000,
  'mestechko-dachnye-istochniki': 14000,
  'mestechko-dolina-geyzerov-tolbachik': 170000,
  'mestechko-kurilskoe-ozero': 105000,
  'mestechko-dolina-geyzerov': 105000,
  'mestechko-vertolet-tolbachik': 165000,
  'mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy': 60000,
  'mestechko-oblet-koryakskiy-avachinskiy': 55000,
  'mestechko-ostrov-starichkov': 12000,
  'mestechko-buhta-russkaya': 20000,
  'mestechko-snegohod-avachinskiy-pereval': 10000,
  'mestechko-snegohod-mys-mayachnyy': 10000,
};

interface Row {
  slug: string;
  raw: string;
  price: number;
  durType: string;
  days: number | null;
  published: boolean;
  pickupType: string | null;
  photos: string[];
  descr: string;
  program: string | null;
}

/** Строки VALUES первого INSERT — по одной на тур. */
function tourRows(): Row[] {
  const body = TOURS_SQL.slice(TOURS_SQL.indexOf('CROSS JOIN (VALUES'), TOURS_SQL.indexOf(') AS v(title, slug'));
  return body.split(/\n  \(/).slice(1).map((raw) => {
    const slug = /^'[^']+', '(mestechko-[a-z0-9-]+)'/.exec(raw)![1];
    const lines = raw.split('\n').map((l) => l.trim());
    const price = Number(/^(\d+)::numeric, \d+,$/.exec(lines[4])![1]);
    const dur = /^[\d.]+::numeric, '(day|multi_day)', (\d+|NULL),$/.exec(lines[5])!;
    const flags = /^(TRUE|FALSE), '(easy|medium|hard|extreme)', (TRUE|FALSE),$/.exec(lines[6])!;
    const program = lines[7].startsWith('NULL::jsonb') ? null : lines[7];
    const pickupLine = lines[11];
    const pickupType = pickupLine.startsWith('NULL') ? null : /^'([a-z_]+)'/.exec(pickupLine)![1];
    const photos = [...(/^ARRAY\[([^\]]*)\]::text\[\],$/.exec(lines[12])?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return {
      slug, raw, price,
      durType: dur[1], days: dur[2] === 'NULL' ? null : Number(dur[2]),
      published: flags[3] === 'TRUE',
      pickupType, photos,
      descr: lines[2],
      program,
    };
  });
}

describe('миграция 1216: исполнитель с реквизитами, без выдуманного', () => {
  it('заводит запись партнёра по slug, и повтор не плодит строк', () => {
    expect(CARD_SQL).toMatch(/INSERT INTO partners/);
    expect(CARD_SQL).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM partners WHERE slug = 'mestechko'\)/);
  });

  it('реквизиты со страницы «О нас» записаны так, как читает страница (legal_info)', () => {
    const legal = extractLegalInfo({
      companyName: 'ООО «Местечко Камчатка»',
      inn: '4100046246',
      ogrn: '1234100001079',
      address: '683009, Камчатский край, Петропавловск-Камчатский, ул. Академика Курчатова, д. 33, кв. 14',
    });
    expect(legal).toMatchObject({ inn: '4100046246', ogrn: '1234100001079' });
    for (const v of ['4100046246', '410001001', '1234100001079', 'ООО «Местечко Камчатка»', 'РТО В031-00161-00/04108813']) {
      expect(CARD_SQL).toContain(v);
    }
  });

  it('карточка открыта по «ДА» оператора, но реестр не сверен и «проверено» не выставлено', () => {
    const tail = CARD_SQL.slice(CARD_SQL.indexOf('logo_image, commission_current, is_public, created_at'));
    expect(tail).toMatch(/'\/images\/mestechko\/logo\.png',\s*\n\s*0,\s*\n\s*TRUE,/);
    expect(CARD).toMatch(/Оператор ответил «ДА»/);
    expect(CARD_SQL).not.toMatch(/registry_status|registry_checked_at|registry_source_url/);
    expect(CARD_SQL).not.toMatch(/is_verified|verified_at/);
  });

  it('комиссия 0 записана явно, по слову владельца оператору; других следов ставки нет', () => {
    expect(CARD_SQL).toMatch(/commission_current/);
    expect(CARD_SQL).not.toMatch(/commission_rate|agent_commission_rate/);
    expect(CARD).toMatch(/комиссию мы не берём/);
  });

  it('не создаёт пользователя, не ставит чужое согласие на ПД, не хранит имён людей', () => {
    expect(CARD_SQL).not.toMatch(/INSERT INTO users/i);
    expect(CARD_SQL).not.toMatch(/user_id/);
    expect(CARD_SQL).not.toMatch(/pd_consent|consent/i);
    // Гиды и менеджеры со страницы «О нас», владелец сайта в соцсетях.
    expect(CARD_SQL).not.toMatch(/Бондарчук|Балтага|Серебряков|Лупарев|Моисеев|Кравченко|Верхотуров|Ерошевск|Дозоров|Павел|director|founder/i);
  });

  it('адрес квартиры из выписки лежит только в реквизитах, не в контактах', () => {
    const contactsBlock = CARD_SQL.slice(CARD_SQL.indexOf("'phone', '+79149981980',\n    'phone2'"), CARD_SQL.indexOf("jsonb_build_object('region'"));
    expect(contactsBlock).not.toMatch(/Курчатова|кв\. 14/);
    expect(contactsBlock).toMatch(/Офиса нет/);
  });

  it('текст карточки не обещает платежей и называет, с кем договор', () => {
    expect(CARD_SQL).toMatch(/Договор о туре заключается с ООО «Местечко Камчатка»/);
    expect(CARD_SQL).toMatch(/Ведар оплату не принимает/);
    expect(CARD_SQL).not.toMatch(/оплатить на сайте|онлайн-оплат/i);
  });

  it('логотип ставится только туда, где его нет, и файл лежит в public', () => {
    expect(CARD_SQL).toMatch(/logo_image IS NULL OR logo_image = ''/);
    const file = join(ROOT, 'public/images/mestechko/logo.png');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(1000);
    const head = readFileSync(file).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('контакты с сайта превращаются в строки карточки: два телефона, Telegram, WhatsApp, MAX, почта, сайт', () => {
    const contacts = {
      phone: '+79149981980',
      phone2: '+79149997729',
      whatsapp: '79149981980',
      telegram_contact: '@Mestechko_kam',
      telegram_channel: 'https://t.me/mestechko_kamchatka',
      max: 'https://max.ru/id4100046246_biz',
      email: 'mestechko41@mail.ru',
      website: 'https://mestechkokam.ru',
    };
    for (const v of Object.values(contacts)) expect(CARD).toContain(v);
    const items = extractContacts(contacts);
    expect(items.filter((c) => c.phone).map((c) => c.phone)).toEqual(['+79149981980', '+79149997729']);
    expect(items.map((c) => c.href).filter(Boolean)).toEqual(
      expect.arrayContaining([
        'https://t.me/Mestechko_kam',
        'https://t.me/mestechko_kamchatka',
        'https://wa.me/79149981980',
        'https://max.ru/id4100046246_biz',
        'mailto:mestechko41@mail.ru',
        'https://mestechkokam.ru',
      ]),
    );
  });
});

describe('миграция 1217: туры «Местечка Камчатка»', () => {
  const rows = tourRows();

  it('18 туров на карточку по slug партнёра, цена за человека, у каждого адрес источника', () => {
    expect(rows.map((r) => r.slug)).toEqual(SLUGS);
    expect(TOURS_SQL).toMatch(/WHERE p\.slug = 'mestechko'/);
    expect(TOURS_SQL).toMatch(/v\.price, 'RUB', 'per_person', 1, v\.max_p/);
    expect(TOURS_SQL).toMatch(/18 THEN/);
    expect((TOURS_SQL.match(/https:\/\/mestechkokam\.ru\/ekskursii\/[a-z0-9-]+\/[a-z0-9-]+\//g) ?? []).length).toBe(18);
  });

  it('цены — дословно с карточек сайта', () => {
    for (const r of rows) expect(r.price, r.slug).toBe(SITE_PRICES[r.slug]);
  });

  it('три тура с противоречивой ценой на сайте — черновики, и price_note называет вторую цифру', () => {
    for (const r of rows) {
      expect(r.published, r.slug).toBe(!DRAFTS.includes(r.slug));
      if (DRAFTS.includes(r.slug)) {
        expect(r.raw, r.slug).toMatch(/Черновик до подтверждения цены оператором/);
        expect(r.raw, r.slug).toMatch(/— \d{2,3} \d{3} ₽; в (списке|каталоге)/);
      } else {
        expect(r.raw, r.slug).not.toMatch(/Черновик/);
      }
    }
  });

  it('туров без цены на сайте (рыбалка, хели-ски) в базе нет, заготовка импорта удалена', () => {
    expect(TOURS_SQL).not.toMatch(/rybalka|heliski|Хели-ски|Утёс/);
    expect(existsSync(join(ROOT, 'app/api/admin/import-mestechko'))).toBe(false);
    expect(TOURS).toMatch(/import-mestechko ставила[\s-]+им 80 000 и 250 000 — удалена/);
  });

  it('ничего не выдумано: нет дат, сезона и условий отмены; описания не короче 300 и не повторяют программу', () => {
    expect(TOURS_SQL).not.toMatch(/season_start|season_end|tour_availability/);
    // Единственная дата в коде — день снятия витрины в price_note.
    expect(TOURS_SQL.replace(/на 12\.10\.2026/g, '')).not.toMatch(/\d{2}\.\d{2}\.202\d/);
    expect(TOURS_SQL).not.toMatch(/cancellation_policy|cancellation_free_days/);
    expect(TOURS_SQL).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    for (const r of rows) {
      expect(r.descr.length, r.slug).toBeGreaterThan(300);
      if (r.program) expect(r.descr, r.slug).not.toMatch(/День 1|Вылет осуществляется/);
    }
  });

  it('программа по шагам — только у вертолётных туров (на сайте она есть лишь там); многодневный — Толбачик на 4 дня', () => {
    for (const r of rows) {
      const heli = /'helicopter'/.test(r.raw.split('\n')[3]);
      expect(Boolean(r.program), r.slug).toBe(heli);
      if (r.program) {
        expect(r.program).toMatch(/^'\[\{"title": /);
        expect((r.program.match(/"title": /g) ?? []).length, r.slug).toBeGreaterThanOrEqual(5);
      }
      if (r.slug === 'mestechko-tolbachik-standard') {
        expect(r.durType).toBe('multi_day');
        expect(r.days).toBe(4);
      } else {
        expect(r.durType, r.slug).toBe('day');
        expect(r.days, r.slug).toBeNull();
      }
    }
  });

  it('подвоз: джип и снегоход — заберут от гостиницы, вертолёт — аэропорт Елизово, море — не записано', () => {
    for (const r of rows) {
      const act = /'(jeep_safari|helicopter|boat_trip|snowmobile)'/.exec(r.raw.split('\n')[3])![1];
      const expected = { jeep_safari: 'hotel_pickup', snowmobile: 'hotel_pickup', helicopter: 'meeting_point', boat_trip: null }[act];
      expect(r.pickupType, r.slug).toBe(expected);
      if (act === 'helicopter') expect(r.raw).toMatch(/Аэропорт Елизово, вылет в 10:00/);
    }
  });

  it('опубликованные джип-, вертолётные и снегоходные туры проходят перепись готовности по полям, которые задаёт миграция', () => {
    for (const r of rows.filter((x) => x.published)) {
      const row: ReadinessRow = {
        id: 1, title: r.slug, operator_id: 'x', operator_name: 'Местечко Камчатка',
        description_chars: r.descr.length,
        photo_count: r.photos.length,
        base_price: r.price,
        duration_hours: 1,
        pickup_type: r.pickupType as ReadinessRow['pickup_type'],
        pickup_details_chars: 40,
        has_meeting_point: r.pickupType !== null,
        has_cancellation_policy: false,
        has_coords: !r.raw.includes('NULL::numeric, NULL::numeric'),
        has_operator_contact: true,
        included_count: 4,
        program_steps: r.program ? 5 : 0,
      };
      const missing = missingFields(row);
      // Условия отмены оператор ещё не назвал — это единственное, чего нет;
      // у озера Толмачёва ещё и координата (в базе не подтверждена).
      const allowed = r.slug === 'mestechko-ozero-tolmachevo' ? ['coordinates', 'cancellation_policy'] : ['cancellation_policy'];
      expect(missing.filter((m) => !allowed.includes(m)), r.slug).toEqual([]);
    }
  });

  it('идемпотентна и сравнивает id текстом; партнёра и пользователя не создаёт', () => {
    expect(TOURS_SQL).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM operator_tours t\s+WHERE t\.operator_id::text = p\.id::text AND t\.slug = v\.slug/);
    expect(TOURS_SQL).not.toMatch(/INSERT INTO partners|INSERT INTO users/);
  });
});

describe('фото туров «Местечка Камчатка»', () => {
  const rows = tourRows();

  it('каждый путь из миграции лежит в public/images/mestechko и сжат; hero — первый снимок', () => {
    expect(TOURS_SQL).toMatch(/v\.photos, v\.photos\[1\]/);
    for (const r of rows) {
      expect(r.photos.length, r.slug).toBeGreaterThanOrEqual(2);
      r.photos.forEach((p, i) => {
        expect(p).toBe(`/images/mestechko/${r.slug.replace(/^mestechko-/, '')}-0${i + 1}.jpg`);
        const file = join(ROOT, 'public', p);
        if (REMOVED.includes(p)) {
          expect(existsSync(file), `${p} снят миграцией 1221 — файла быть не должно`).toBe(false);
          return;
        }
        expect(existsSync(file), p).toBe(true);
        expect(statSync(file).size, p).toBeLessThan(300 * 1024);
      });
    }
  });

  it('оригиналы с сайта в репозитории не лежат, файлов ровно столько, сколько названо минус снятые, плюс логотип', () => {
    const dir = join(ROOT, 'public/images/mestechko');
    expect(existsSync(join(dir, 'raw'))).toBe(false);
    expect(REMOVED.length, 'снятый автобус (1221) должен числиться снятым').toBeGreaterThan(0);
    const jpgs = readdirSync(dir).filter((f) => /^[a-z0-9-]+-0\d\.jpg$/.test(f));
    const named = rows.flatMap((r) => r.photos.filter((p) => !REMOVED.includes(p)).map((p) => p.replace('/images/mestechko/', '')));
    expect(jpgs.sort()).toEqual([...named].sort());
    expect(existsSync(join(dir, 'logo.png'))).toBe(true);
  });
});
