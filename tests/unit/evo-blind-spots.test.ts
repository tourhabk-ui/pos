/**
 * Слепые зоны эволюции, вскрытые разбором 28.07.
 *
 * Владелец спросил: почему сканер не нашёл выдуманные партнёрские блоки?
 * Разбор по коду дал три причины, и ни одна не была «модель недодумала»:
 *
 *  1. components/ вообще не входил в обход репозитория (WALK_ROOTS = app, lib),
 *     а мок-детектор брал кандидатов только из app/. Блоки лежали в
 *     components/routes/ — вне поля зрения по построению.
 *  2. Локальный обход объявлял источник 'disk' при ЛЮБОМ непустом результате.
 *     На проде в контейнере лежит горстка .ts, фоллбэк на GitHub не срабатывал,
 *     и прочёс всей платформы схлопывался: прогон 28.07 00:09 отчитался
 *     files_listed: 10 при зелёном статусе — покрытие в доли процента выглядело
 *     как здоровье.
 *  3. Линзы, добавленной под этот класс (ссылка без атрибуции и без маркировки
 *     рекламы), просто не существовало.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { clientComponentPaths } from '@/lib/agents/evo/repo-files';
import { findUnattributedAffiliateLinks } from '@/lib/agents/evo/structural-scan';

const REPO_FILES_SRC = readFileSync(join(process.cwd(), 'lib/agents/evo/repo-files.ts'), 'utf-8');

describe('обход репозитория', () => {
  it('components/ входит в обход', () => {
    expect(REPO_FILES_SRC).toContain("const WALK_ROOTS = ['app', 'lib', 'components']");
  });

  it('мок-детектор видит блоки из components, не только экраны из app', () => {
    const picked = clientComponentPaths([
      'app/hub/operator/page.tsx',
      'components/routes/RouteAffiliateBlock.tsx',
      'lib/services/x.ts',
      'components/routes/Foo.test.tsx',
    ]);
    expect(picked).toContain('app/hub/operator/page.tsx');
    expect(picked).toContain('components/routes/RouteAffiliateBlock.tsx');
    expect(picked).not.toContain('lib/services/x.ts');
    expect(picked).not.toContain('components/routes/Foo.test.tsx');
  });

  it('горстка файлов на диске не считается репозиторием', () => {
    // Иначе прод-прогон объявляет источник 'disk' по десяти файлам и рапортует
    // о полном покрытии, обойдя 0.6% платформы.
    expect(REPO_FILES_SRC).toContain('MIN_PLAUSIBLE_LOCAL_FILES');
    expect(REPO_FILES_SRC).toContain('files.length >= MIN_PLAUSIBLE_LOCAL_FILES');
  });
});

describe('линза партнёрских ссылок', () => {
  const withMarker = `
    'use client';
    const url = 'https://www.aviasales.ru/search/MOW0000PKC1?marker=402896';
    // Реклама. ООО «Пример», ИНН: 0000000000. erid: 2Vtzqv0000.
  `;
  const noMarker = `
    'use client';
    const link = 'https://kiwitaxi.ru/?aff_id=402896';
    const plan = 'https://cherehapa.ru/?plan=basic';
  `;
  const neutral = `
    'use client';
    const mchs = 'https://forms.mchs.gov.ru/registration_tourist_groups/form';
    const park = 'https://kronoki.ru/ru/visit/requests/';
  `;

  it('размеченный блок с маркером претензий не вызывает', () => {
    expect(findUnattributedAffiliateLinks(new Map([['components/routes/Ok.tsx', withMarker]]))).toHaveLength(0);
  });

  it('ссылка без идентификатора — находка: клик уходит бесплатно', () => {
    const issues = findUnattributedAffiliateLinks(new Map([['components/routes/Bad.tsx', noMarker]]));
    expect(issues.some(i => i.title.includes('без атрибуции'))).toBe(true);
  });

  it('партнёрский блок без erid и «Реклама» — находка по закону о рекламе', () => {
    const issues = findUnattributedAffiliateLinks(new Map([['components/routes/Bad.tsx', noMarker]]));
    const compliance = issues.find(i => i.category === 'compliance');
    expect(compliance).toBeDefined();
    expect(compliance?.severity).toBe('high');
  });

  it('ссылки на МЧС и заповедник не трогаем — там атрибуции быть не должно', () => {
    expect(findUnattributedAffiliateLinks(new Map([['components/Neutral.tsx', neutral]]))).toHaveLength(0);
  });

  it('шаблонная подстановка маркера считается атрибуцией', () => {
    const templated = `
      const url = \`https://ostrovok.ru/hotel/russia/petropavlovsk_kamchatsky/?marker=\${MARKER}\`;
      // Реклама. erid: 2Vtzqv0000.
    `;
    expect(findUnattributedAffiliateLinks(new Map([['components/routes/T.tsx', templated]]))).toHaveLength(0);
  });
});

describe('живые блоки платформы проходят новую линзу', () => {
  it('ни одной находки на настоящих партнёрских блоках', () => {
    const bodies = new Map<string, string>();
    for (const p of ['components/routes/RouteAffiliateBlock.tsx', 'components/routes/YandexTravelBlock.tsx']) {
      bodies.set(p, readFileSync(join(process.cwd(), p), 'utf-8'));
    }
    const issues = findUnattributedAffiliateLinks(bodies);
    expect(issues, issues.map(i => `${i.file_path}: ${i.title}`).join('; ')).toHaveLength(0);
  });
});

describe('линза не кричит волком', () => {
  it('на живом репозитории находок ноль', () => {
    // Живой инвариант: если линза начнёт клеймить честные ссылки (МЧС,
    // заповедники, документация в комментариях), тест покраснеет здесь, а не
    // мусором в тикетах. Единственный настоящий нарушитель убран в #851.
    const bodies = new Map<string, string>();
    // withFileTypes: тип узнаём из той же записи каталога, что и имя, — без
    // отдельного stat между проверкой и чтением. Иначе между «это файл» и
    // «читаем» лежит окно, в котором файл мог смениться (CodeQL справедливо
    // указал на это в первой версии теста).
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, entry.name);
        if (entry.isDirectory()) walk(f);
        else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
          bodies.set(relative(process.cwd(), f), readFileSync(f, 'utf-8'));
        }
      }
    };
    walk(join(process.cwd(), 'components'));
    walk(join(process.cwd(), 'app'));

    const issues = findUnattributedAffiliateLinks(bodies);
    expect(issues, issues.map(i => `${i.file_path}: ${i.title}`).join('; ')).toHaveLength(0);
  });

  it('админка исключена: там ссылки на кабинеты площадок — навигация', () => {
    const admin = new Map([['app/hub/admin/channels/_X.tsx', "const u = 'https://avito.ru/profile';"]]);
    expect(findUnattributedAffiliateLinks(admin)).toHaveLength(0);
  });

  it('ссылка в комментарии рекламой не считается', () => {
    const doc = new Map([['components/shared/X.tsx', ' // Docs: https://support.travelpayouts.com/hc/ru\nconst a = 1;']]);
    expect(findUnattributedAffiliateLinks(doc)).toHaveLength(0);
  });
});
