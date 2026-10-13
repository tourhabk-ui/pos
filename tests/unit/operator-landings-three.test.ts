// @vitest-environment node
/**
 * Страницы трёх операторов — наполнение, как у «Камчатской рыбалки»
 * (владелец 13.10: «нужно каждому партнёру сделать красивый лендинг как у
 * Камчатской рыбалки» → «делай три страницы»). Миграция 1222 заполняет
 * Местечку, Краю Вулканов и Семейному Рафтингу главное фото, галерею,
 * услуги, особенности и вопросы; рафтингу — ещё описания.
 *
 * Что держит сторож:
 *  - каждый JSON-блок валиден и читается теми же разборщиками, что страница
 *    (lib/operators/profile-parse) — блок, который страница не поймёт,
 *    молча исчез бы с экрана;
 *  - каждое фото галереи и главное фото существуют в public, а те, что
 *    тяжелее порога оптимизатора, есть в манифесте вариантов — иначе
 *    страница поедет оригиналом;
 *  - иконки особенностей — только из ICON_MAP страницы оператора: чужое имя
 *    рисуется щитом, и шесть одинаковых щитов никто не заметит;
 *  - каждая правка гейтится пустотой поля: кабинет оператора пишет те же
 *    колонки, миграция не перетирает его правку;
 *  - у каждого блока в комментарии перед ним назван источник (сайт партнёра
 *    или миграция с данными оператора) — правило «из данных, не из головы»;
 *  - цифр, которых источники не называли (проценты скидок), в текстах нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '@/lib/images/photo-variants.json';
import { extractGallery, extractServices, extractFeatures, extractFaq } from '@/lib/operators/profile-parse';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MIG = read('migrations/1222_operator_landings_three.sql');
const PAGE = read('app/operators/[slug]/page.tsx');

/** Тот же порог, что в scripts/optimize-images.mjs и tests/unit/photo-variants. */
const MIN_BYTES = 50 * 1024;
const IN_MANIFEST = new Set((manifest as Array<{ src: string }>).map((e) => e.src));

const SLUGS = ['mestechko', 'volcanoesland', 'kamchatka-rafting'] as const;
type Slug = (typeof SLUGS)[number];

interface JsonBlock {
  column: string;
  slug: Slug;
  json: unknown;
  /** Комментарий между предыдущим блоком и этим. */
  preamble: string;
}

/** Все `SET <col> = $json$…$json$::jsonb … WHERE slug = '…'` миграции. */
function jsonBlocks(): JsonBlock[] {
  const re = /UPDATE partners\s+SET (\w+) = \$json\$([\s\S]*?)\$json\$::jsonb[\s\S]*?WHERE slug = '([\w-]+)'/g;
  const out: JsonBlock[] = [];
  let last = 0;
  for (const m of MIG.matchAll(re)) {
    const preamble = MIG.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    out.push({ column: m[1], slug: m[3] as Slug, json: JSON.parse(m[2]), preamble });
  }
  return out;
}

function heroOf(slug: Slug): string {
  const m = MIG.match(new RegExp(`SET hero_image = '([^']+)',\\s*\\n\\s*updated_at = NOW\\(\\)\\s*\\n\\s*WHERE slug = '${slug}'`));
  if (!m) throw new Error(`hero_image для ${slug} не найден`);
  return m[1];
}

const BLOCKS = jsonBlocks();
const by = (slug: Slug, column: string) => BLOCKS.find((b) => b.slug === slug && b.column === column);

const ICON_MAP_NAMES = (() => {
  const m = PAGE.match(/const ICON_MAP[^=]*=\s*\{([^}]+)\}/);
  if (!m) throw new Error('ICON_MAP не найден на странице оператора');
  return new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
})();

describe('миграция 1222: три оператора, четыре блока у каждого', () => {
  it('у каждого — галерея, услуги, особенности и вопросы', () => {
    for (const slug of SLUGS) {
      for (const column of ['gallery', 'services', 'features', 'faq']) {
        expect(by(slug, column), `${slug}.${column}`).toBeTruthy();
      }
    }
    expect(BLOCKS).toHaveLength(SLUGS.length * 4);
  });

  it('галерея: не меньше десяти кадров, все существуют, тяжёлые — в манифесте вариантов', () => {
    for (const slug of SLUGS) {
      const gallery = extractGallery(by(slug, 'gallery')!.json);
      expect(gallery.length, slug).toBeGreaterThanOrEqual(10);
      expect(new Set(gallery).size, `${slug}: дубли`).toBe(gallery.length);
      for (const src of gallery) {
        const file = join(ROOT, 'public', src);
        expect(existsSync(file), src).toBe(true);
        if (statSync(file).size >= MIN_BYTES) expect(IN_MANIFEST.has(src), `${src} не в манифесте`).toBe(true);
      }
    }
  });

  it('главное фото существует и открывает галерею', () => {
    for (const slug of SLUGS) {
      const hero = heroOf(slug);
      expect(existsSync(join(ROOT, 'public', hero)), hero).toBe(true);
      expect(extractGallery(by(slug, 'gallery')!.json)[0], slug).toBe(hero);
    }
  });

  it('услуги, особенности и вопросы читаются разборщиками страницы целиком', () => {
    for (const slug of SLUGS) {
      const services = by(slug, 'services')!.json as unknown[];
      const features = by(slug, 'features')!.json as unknown[];
      const faq = by(slug, 'faq')!.json as unknown[];
      expect(extractServices(services), `${slug}: услуги`).toHaveLength(services.length);
      expect(extractFeatures(features), `${slug}: особенности`).toHaveLength(features.length);
      expect(extractFaq(faq), `${slug}: вопросы`).toHaveLength(faq.length);
      expect(features.length, slug).toBeGreaterThanOrEqual(5);
      expect(faq.length, slug).toBeGreaterThanOrEqual(4);
      for (const f of extractFaq(faq)) {
        expect(f.q.endsWith('?'), f.q).toBe(true);
        expect(f.a.length, f.q).toBeGreaterThan(40);
      }
    }
  });

  it('иконки особенностей — из ICON_MAP страницы, не выдуманные имена', () => {
    expect(ICON_MAP_NAMES.size).toBeGreaterThanOrEqual(6);
    for (const slug of SLUGS) {
      for (const f of extractFeatures(by(slug, 'features')!.json)) {
        expect(f.icon, `${slug}: ${f.title}`).toBeTruthy();
        expect(ICON_MAP_NAMES.has(f.icon!), `${slug}: иконка ${f.icon}`).toBe(true);
      }
    }
  });
});

describe('миграция 1222: только заполняет пустое', () => {
  it('каждый UPDATE гейтится пустотой своей колонки и адресован одному slug', () => {
    const updates = MIG.split(/\bUPDATE partners\b/).slice(1);
    expect(updates.length).toBe(SLUGS.length * 4 + 3 + 2);
    for (const u of updates) {
      const col = u.match(/^\s*SET (\w+) =/)?.[1];
      expect(col, u.slice(0, 60)).toBeTruthy();
      expect(u, col).toMatch(/WHERE slug = '(mestechko|volcanoesland|kamchatka-rafting)'/);
      const gate = col === 'hero_image' || col === 'description' || col === 'short_description'
        ? new RegExp(`NULLIF\\(btrim\\(COALESCE\\(${col}, ''\\)\\), ''\\) IS NULL`)
        : new RegExp(`\\(${col} IS NULL OR jsonb_typeof\\(${col}\\) <> 'array' OR jsonb_array_length\\(${col}\\) = 0\\)`);
      expect(u, `${col}: гейт`).toMatch(gate);
    }
  });

  it('своих BEGIN/COMMIT в файле нет — транзакцию держит раннер', () => {
    // kernel-pg 13.10: COMMIT после строки комментария раннер не узнал как
    // служебный, отправил в базу и закрыл свою транзакцию раньше времени
    // («RELEASE SAVEPOINT can only be used in transaction blocks»).
    expect(MIG).not.toMatch(/^\s*(BEGIN|COMMIT|END)\s*;/m);
  });

  it('рафтингу даются описания, которых у партнёра не было; остальным — нет', () => {
    const descr = [...MIG.matchAll(/SET (short_)?description = [\s\S]*?WHERE slug = '([\w-]+)'/g)].map((m) => m[2]);
    expect(descr).toEqual(['kamchatka-rafting', 'kamchatka-rafting']);
  });
});

describe('миграция 1222: из данных, не из головы', () => {
  const SOURCE = /mestechkokam\.ru|\/o-nas\/|\/vopros-otvet\/|volcanoesland\.ru|\/company\/|\/information\/|\b(793|806|815|822|794|795|1176|1177|1217)\b/;

  it('у каждого блока в комментарии перед ним назван источник', () => {
    for (const b of BLOCKS) {
      const tail = b.preamble.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
      expect(tail, `${b.slug}.${b.column}`).toMatch(SOURCE);
    }
  });

  it('шапка называет сайты партнёров и миграции с данными оператора сплава', () => {
    // Шапка — всё до первой правки. (Срез до 'BEGIN;' устарел вместе с самим
    // BEGIN: indexOf отвечал -1, и «шапкой» оказывался весь файл без последнего
    // символа — проверка проходила, не проверяя шапку.)
    const firstUpdate = MIG.indexOf('UPDATE partners');
    expect(firstUpdate).toBeGreaterThan(0);
    const head = MIG.slice(0, firstUpdate);
    for (const s of ['mestechkokam.ru', 'volcanoesland.ru', '793', '806', '822']) expect(head).toContain(s);
    expect(head).toMatch(/Чего в источниках нет|чего в источниках нет/i);
  });

  it('размер скидок и проценты не выдуманы: процентов в текстах нет, скидка — «уточняйте у оператора»', () => {
    for (const b of BLOCKS) expect(JSON.stringify(b.json), `${b.slug}.${b.column}`).not.toMatch(/\d\s?%/);
    const raft = JSON.stringify(by('kamchatka-rafting', 'services')!.json);
    expect(raft).toContain('уточняйте у оператора');
  });

  it('у каждого оператора записано, чего мы о нём не знаем', () => {
    for (const name of ['Местечке', 'Крае Вулканов', 'Семейном Рафтинге']) {
      expect(MIG).toMatch(new RegExp(`Чего мы не знаем о ${name}`));
    }
  });
});
