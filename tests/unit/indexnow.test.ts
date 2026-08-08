/**
 * IndexNow: ключ согласован, пинги подключены к записи туров, отказы видимы.
 *
 * Владелец 06.08: «делай». Для рунка главный поисковик — Яндекс (соавтор
 * протокола): пинг доводит изменённую страницу до переобхода за минуты вместо
 * недель. Ключ — не секрет по замыслу: публикуется на самом сайте и лишь
 * подтверждает владение хостом, поэтому живёт в коде без env-трения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEXNOW_KEY, pingIndexNow } from '@/lib/seo/indexnow';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('ключ и файл подтверждения', () => {
  it('ключ — 32 hex-символа, как требует спецификация', () => {
    expect(INDEXNOW_KEY).toMatch(/^[a-f0-9]{32}$/);
  });

  it('роут /indexnow.txt отдаёт ровно этот ключ', () => {
    const route = read('app/indexnow.txt/route.ts');
    expect(route).toMatch(/INDEXNOW_KEY/);
    expect(route).toMatch(/text\/plain/);
  });

  it('файл ключа не под запретом robots (/api/ закрыт, /indexnow.txt — нет)', () => {
    const robots = read('app/robots.ts');
    expect(robots).not.toMatch(/indexnow/i);
    // Ключ живёт вне /api/ — иначе краулер, уважающий robots, не смог бы
    // подтвердить владение.
    expect(read('lib/seo/indexnow.ts')).toMatch(/\/indexnow\.txt/);
  });
});

describe('пинг подключён к путям записи тура', () => {
  const WRITERS = [
    'app/api/admin/operator-tours/[id]/route.ts',
    'app/api/hub/operator/tours/[id]/route.ts',
  ];

  it('оба PATCH-пути пингуют изменение', () => {
    for (const file of WRITERS) {
      expect(read(file), `${file} не пингует IndexNow`).toMatch(/pingTourChanged\(tourId\)/);
    }
  });

  it('пинг — попутный эффект: не await, ответ его не ждёт', () => {
    const lib = read('lib/seo/indexnow.ts');
    expect(lib).toMatch(/void pingIndexNow/);
    for (const file of WRITERS) {
      expect(read(file)).not.toMatch(/await pingTourChanged/);
    }
  });
});

describe('канонический адрес тура один — /catalog/tours/', () => {
  // Карточка тура живёт по двум URL (catalog и marketplace), но «настоящий»
  // адрес — один: его подаёт sitemap и на него ведёт навигация. Раньше каждая
  // страница объявляла каноном саму себя, а пинг слал marketplace — мы сами
  // делили сигналы тура между двумя адресами.
  it('sitemap подаёт туры по /catalog/tours/', () => {
    expect(read('lib/seo/sitemap-entries.ts')).toMatch(/\/catalog\/tours\/\$\{row\.id\}/);
  });

  it('пинг изменения тура шлёт канонический адрес, не marketplace', () => {
    const lib = read('lib/seo/indexnow.ts');
    expect(lib).toMatch(/\/catalog\/tours\/\$\{tourId\}/);
    expect(lib).not.toMatch(/\/marketplace\/tours\//);
  });

  it('обе страницы тура объявляют каноном /catalog/tours/', () => {
    for (const file of [
      'app/catalog/tours/[id]/page.tsx',
      'app/marketplace/tours/[id]/page.tsx',
    ]) {
      const src = read(file);
      const canon = /canonical:\s*`\$\{SITE\}([^`]*)`/.exec(src);
      expect(canon, `${file}: canonical не найден`).toBeTruthy();
      expect(canon![1], `${file}: канон должен вести на /catalog/tours/`).toMatch(/^\/catalog\/tours\//);
      expect(src, `${file}: JSON-LD должен строиться на каноне`).toMatch(/canonicalUrl: `\$\{SITE\}\/catalog\/tours\//);
    }
  });
});

describe('пинг подключён к правкам мест и маршрутов', () => {
  it('админ-правка места пингует адрес как в sitemap (slug, иначе ark_id)', () => {
    const src = read('app/api/admin/places/[id]/route.ts');
    expect(src).toMatch(/pingPlaceChanged\(/);
    expect(src, 'адрес пинга должен предпочитать slug').toMatch(/slug \?\? .*ark_id/);
    expect(src).not.toMatch(/await pingPlaceChanged/);
  });

  it('импорт паспортов маршрутов пингует обогащённые маршруты', () => {
    const src = read('app/api/admin/import/route-passports/route.ts');
    expect(src).toMatch(/pingRoutesChanged\(/);
    expect(src, 'адрес пинга должен предпочитать slug').toMatch(/slug \?\? /);
  });

  it('пустой список маршрутов не создаёт пинга', () => {
    const lib = read('lib/seo/indexnow.ts');
    expect(lib).toMatch(/slugsOrIds\.length === 0\) return/);
  });
});

describe('поведение пинга', () => {
  it('пустой список — не ошибка и не запрос', async () => {
    const r = await pingIndexNow([]);
    expect(r).toEqual({ ok: true, submitted: 0 });
  });

  it('отказы записываются, а не глотаются', () => {
    const lib = read('lib/seo/indexnow.ts');
    expect(lib).toMatch(/indexnow_failed/);
    // Ответ читается текстом — не-JSON не прячет причину (урок MAX).
    expect(lib).toMatch(/res\.text\(\)/);
  });

  it('bulk-подача берёт адреса из sitemap, а не ведёт второй список', () => {
    // Сборщик переехал в lib/seo/sitemap-entries (runtime-sitemap, 08.08) —
    // инвариант прежний: один источник адресов на sitemap и IndexNow.
    const bulk = read('app/api/admin/indexnow/bulk/route.ts');
    expect(bulk).toMatch(/from '@\/lib\/seo\/sitemap-entries'/);
    expect(bulk).toMatch(/requireAdmin/);
  });
});
