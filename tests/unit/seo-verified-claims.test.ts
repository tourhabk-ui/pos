// @vitest-environment node
/**
 * «Проверенный оператор» — только там, где проверку видно в данных (13.10).
 *
 * Витрина туров не фильтрует по проверке оператора: publicTourSql держит
 * is_active, is_published и deleted_at, а partners.is_verified в нём нет;
 * список операторов фильтрует только is_public. При этом сайт обещал
 * «реальные туры от проверенных операторов» в описании по умолчанию и в
 * разметке WebSite, «Только проверенные операторы» на /about, «N проверенных
 * оператора» на /operators, «каждый тур — предложение проверенного
 * оператора» в llms.txt, «реальный тур от проверенного оператора» в запасном
 * описании карточки. Это та же болезнь, что отметка «проверен платформой» у
 * любого оператора на самой карточке до 24.09 (аудит П6, #138): обещание без
 * исполнения (§4.0). Карточку тогда вылечили полем operator_verified; здесь —
 * то же правило для текстов, которые читают поиск, AI и турист.
 *
 * Связка, а не половина: пока витрина не фильтрует по проверке, ни один текст
 * не обещает проверенных операторов огулом. Начнёт фильтровать (решение
 * владельца) — запрет снимается сам. Про конкретного оператора — можно, если
 * это сказано по его is_verified: так устроены запасное описание тура и строка
 * тура в llms.txt, и это проверяется вызовом ниже.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { publicTourSql } from '@/lib/tours/public-visibility';

const poolQuery = vi.fn();
const loadTourCard = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/tours/tour-detail-query', () => ({
  loadTourCard: (...a: unknown[]) => loadTourCard(...a),
  getTourReviews: async () => [],
}));

const ROOT = process.cwd();
/** «проверенные (туристические) операторы», «туроператоры проверенные» — в любом падеже. */
const CLAIM = /проверенн[а-яё]*\s+(?:[а-яё]+\s+)?(?:тур)?оператор|оператор[а-яё]*\s+проверенн/i;

/**
 * Где фраза сказана по данным конкретного оператора, а не огулом. Запись
 * самоустаревает: фраза из файла ушла — запись обязана уйти.
 */
const BY_DATA: Record<string, string> = {
  'app/catalog/tours/[id]/page.tsx': 'запасное описание тура — только при operator_verified === true (вызов ниже)',
  'app/operators/[slug]/page.tsx': 'подпись под именем — только внутри {profile.is_verified && …}',
};

/** Тексты, которые видит человек или модель: строки, шаблоны, текст JSX. Комментарии — мимо. */
function userTexts(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf-8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of ['app', 'components', 'lib']) walk(d);
  return out;
}

describe('огульное «проверенные операторы» — только если витрина проверяет', () => {
  const filtersByVerification = /is_verified/.test(publicTourSql('ot'));

  it('витрина сегодня не фильтрует по проверке оператора', () => {
    // Если это изменится, тест ниже перестанет запрещать — и это видно здесь.
    expect(filtersByVerification).toBe(false);
  });

  it('ни строка, ни шаблон, ни текст разметки не обещает проверенных операторов огулом', () => {
    if (filtersByVerification) return;
    const files = sources();
    expect(files.length).toBeGreaterThan(1000);
    const hits: string[] = [];
    for (const f of files) {
      if (BY_DATA[f]) continue;
      for (const t of userTexts(f)) {
        const m = t.match(CLAIM);
        if (m) hits.push(`${f}: «…${t.slice(Math.max(0, m.index! - 30), m.index! + 40).replace(/\s+/g, ' ')}…»`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('исключения по данным живы: фраза в файле есть', () => {
    for (const f of Object.keys(BY_DATA)) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(userTexts(f).some((t) => CLAIM.test(t)), `${f}: фразы нет — запись в BY_DATA лишняя`).toBe(true);
    }
  });
});

describe('про конкретного оператора — по его is_verified', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    loadTourCard.mockReset();
  });

  async function fallbackDescription(verified: boolean | null): Promise<string> {
    loadTourCard.mockResolvedValue({
      tour: {
        id: 7, slug: 'tour', title: 'Мыс Маячный', activity_type: 'boat_trip',
        short_description: null, description: null, photos: [], tour_image: null,
        operator_name: 'Местечко', operator_verified: verified,
      },
      byId: false,
    });
    const { generateMetadata } = await import('@/app/catalog/tours/[id]/page');
    return String((await generateMetadata({ params: Promise.resolve({ id: 'tour' }) })).description);
  }

  it('запасное описание тура: «проверенного» — только у проверенного', async () => {
    expect(await fallbackDescription(true)).toMatch(/тур проверенного оператора Местечко/);
    for (const v of [false, null]) {
      const d = await fallbackDescription(v);
      expect(d).toMatch(/тур оператора Местечко/);
      expect(d).not.toMatch(/проверен/i);
    }
  });

  it('llms.txt: отметка в строке тура — по is_verified, огулом — нигде', async () => {
    poolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM operator_tours')) {
        return Promise.resolve({ rows: [
          { id: '1', slug: 'mys-mayachnyy', title: 'Мыс Маячный', base_price: '9000', activity_type: 'boat_trip', operator_name: 'Местечко', operator_verified: true },
          { id: '2', slug: 'dolina', title: 'Долина гейзеров', base_price: '60000', activity_type: 'helicopter', operator_name: 'Край Вулканов', operator_verified: false },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    const line = (title: string) => text.split('\n').find((l) => l.includes(`[${title}]`)) ?? '';
    expect(line('Мыс Маячный')).toMatch(/оператор: Местечко \(проверен платформой\)/);
    expect(line('Долина гейзеров')).toMatch(/оператор: Край Вулканов$/);
    expect(text).not.toMatch(CLAIM);
  });
});
