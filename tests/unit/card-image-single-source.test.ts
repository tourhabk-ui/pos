/**
 * Картинку карточки выбирает одна функция, и перепись спрашивает её же.
 *
 * ── Случай 20.09 ───────────────────────────────────────────────────────────
 *
 * Владелец прислал снимок каталога `/places` с вопросом «что за фото?»: на
 * карточках термальных источников стояли кадры с тилингом «alamy» — витринные
 * превью фотобанка, — а у «Голыгинских» картинка была не источника вовсе.
 *
 * Разбор упёрся не в сами снимки, а в то, что ответ «какую картинку покажет
 * карточка» собирался в трёх местах, и одно из трёх отвечало НЕВЕРНО. Перепись
 * `place-photo-coverage`, заведённая ровно затем, чтобы отвечать на вопрос
 * «где фото», говорила про место без снимка: «карточка покажет градиент, и это
 * правда». Градиента там нет — подставляется кадр стороннего оператора
 * (`/images/partners/kamchatintour/...`) по категории места.
 *
 * Это не описка. Это §12 («правило, реализованное дважды, — это два правила»)
 * в применении к ПЕРЕПИСИ: инструмент, измеряющий чужое поведение своей копией
 * правила, рано или поздно измеряет собственную копию.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 *  - выбор РОДА картинки живёт в `lib/routes/card-image.ts`;
 *  - каталог не собирает адрес выражением на месте;
 *  - перепись не заводит своей таблицы подстановок и не утверждает про
 *    градиент от себя;
 *  - у рода `gradient` адреса нет, у остальных — есть (иначе «картинки нет» и
 *    «картинка чужая» снова станут неразличимы).
 *
 * ЧЕГО ОН НЕ ДЕРЖИТ, и это названо, чтобы не читалось шире написанного:
 * `PlaceCard` и карточка маршрута по-прежнему собирают адрес СОБСТВЕННОГО
 * снимка (`/api/images/route/<id>`) своим выражением. Это копия формы адреса,
 * а не копия правила выбора: род там уже решён выше. Свести и её — отдельная
 * работа, а не побочный эффект этой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardImage,
  categoryFallbackImage,
  pickPayloadImage,
  CATEGORY_FALLBACK_IMAGES,
} from '@/lib/routes/card-image';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const CATALOG = read('lib/routes/catalog-query.ts');
const CENSUS = read('app/api/cron/place-photo-coverage/route.ts');

/** Комментарии вырезаны: сторож не должен краснеть на словах о себе. */
const code = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('род картинки называется честно', () => {
  it('свой показываемый снимок — own, и адрес ведёт на него', () => {
    const r = cardImage({ hasShownPhoto: true, id: 'abc', category: 'vulkani' });
    expect(r.kind).toBe('own');
    expect(r.url).toBe('/api/images/route/abc');
  });

  it('у МЕСТА без снимка — градиент, подстановки больше нет', () => {
    // Решение владельца 20.09 по числу с прода: из 378 живых мест свой снимок
    // у 110, а кадр оператора подставлялся у 226 — у двух карточек из трёх
    // витрина показывала чужую картинку как снимок этого места. Выбран первый
    // из трёх путей: снять, а не подписать и не оставить.
    const r = cardImage({ hasShownPhoto: false, id: 'abc', category: 'termalnye_istochniki', kind: 'place' });
    expect(r.kind).toBe('gradient');
    expect(r.url).toBeNull();
  });

  it('род не передан — считается местом: умолчание в сторону «не подставлять»', () => {
    expect(cardImage({ hasShownPhoto: false, id: 'abc', category: 'vulkani' }).kind).toBe('gradient');
  });

  it('у МАРШРУТА и ТУРА подстановка осталась — это другое решение', () => {
    // У места карточка утверждает географический факт: вот место, вот его
    // снимок. У тура карточка — витрина предложения оператора, и кадр
    // оператора там не подменяет собой объект. Владелец менял первое.
    for (const kind of ['route', 'tour'] as const) {
      const r = cardImage({ hasShownPhoto: false, id: 'abc', category: 'termalnye_istochniki', kind });
      expect(r.kind, kind).toBe('category_fallback');
      expect(r.url, kind).toContain('/images/partners/kamchatintour/');
    }
  });

  it('категория незнакомая — градиент, и адреса нет', () => {
    const r = cardImage({ hasShownPhoto: false, id: 'abc', category: 'нечто-своё', kind: 'route' });
    expect(r.kind).toBe('gradient');
    expect(r.url).toBeNull();
  });

  it('категории нет вовсе — тоже градиент', () => {
    expect(cardImage({ hasShownPhoto: false, id: 'abc', category: null, kind: 'route' }).kind).toBe('gradient');
  });

  it('адрес из payload идёт вперёд подстановки и назван своим родом', () => {
    const r = cardImage({
      hasShownPhoto: false, id: 'abc', category: 'vulkani', kind: 'route',
      payload: { image: 'https://example.org/photo.jpg' },
    });
    expect(r.kind).toBe('payload_link');
    expect(r.url).toBe('https://example.org/photo.jpg');
  });

  it('у мест payload пуст — ветка не срабатывает, и это не измерение', () => {
    // VIEW agent_route_knowledge отдаёт местам '{}'::jsonb (миграция 942).
    // Счёт «сколько мест показывают картинку из payload» вернул бы ноль по
    // построению — такой ноль ничего не меряет.
    expect(pickPayloadImage({})).toBeNull();
  });

  it('подстановка ищется и по смыслу слова, не только по точному ключу', () => {
    expect(categoryFallbackImage('Горячие источники')).toBe(CATEGORY_FALLBACK_IMAGES.termalnye_istochniki);
    expect(categoryFallbackImage('')).toBeNull();
  });
});

describe('каталог не выбирает картинку сам', () => {
  it('зовёт cardImage', () => {
    expect(CATALOG).toContain("from '@/lib/routes/card-image'");
    expect(CATALOG).toMatch(/cardImage\(\{/);
  });

  it('своего выражения с адресом снимка в каталоге не осталось', () => {
    expect(code(CATALOG), 'адрес снимка снова собирается на месте')
      .not.toMatch(/`\/api\/images\/route\/\$\{/);
  });

  it('своей таблицы подстановок в каталоге нет', () => {
    expect(code(CATALOG)).not.toContain('kamchatintour');
  });
});

describe('перепись спрашивает карточку, а не рассказывает о ней', () => {
  it('зовёт ту же функцию', () => {
    expect(CENSUS).toContain("from '@/lib/routes/card-image'");
    expect(CENSUS).toMatch(/cardImage\(\{/);
  });

  it('не заводит своей таблицы подстановок', () => {
    // Строка с путём допустима только в объяснении для человека, которое
    // печатается ПОСЛЕ проверки рода; таблицы соответствий быть не должно.
    expect(code(CENSUS)).not.toMatch(/CATEGORY_FALLBACK|vulkani:/);
  });

  it('прежнего неверного приговора в тексте не осталось', () => {
    expect(CENSUS, 'перепись снова обещает градиент всем без снимка')
      .not.toContain('карточка покажет градиент, и это правда');
  });

  it('отдаёт счёт по родам картинки', () => {
    expect(CENSUS).toContain('card_image_kind');
    for (const kind of ['own', 'payload_link', 'category_fallback', 'gradient']) {
      expect(CENSUS, `в счёте нет рода ${kind}`).toContain(kind);
    }
  });

  it('отдаёт происхождение ПОКАЗЫВАЕМЫХ снимков — иначе чужой кадр не найти', () => {
    expect(CENSUS).toContain('shown_photos');
    expect(CENSUS).toContain('by_source_host');
    expect(CENSUS).toContain('without_author');
  });

  it('о правах по роду не судит: вотермарк в SQL не виден', () => {
    // Признак «чужое», выведенный из рода снимка, был бы выдумкой (§4.0):
    // род говорит, кто строку записал, а не чьи на ней пиксели. Проверяется
    // КОД без комментариев — иначе сторож ловил бы собственную шапку
    // переписи, где повод (кадры фотобанка) назван по имени, и приучал бы
    // вычищать из шапок ровно то, ради чего шапки и пишут.
    expect(code(CENSUS).toLowerCase()).not.toMatch(/alamy|stock|фотобанк/);
  });

  it('перепись осталась читающей', () => {
    for (const verb of ['UPDATE ', 'INSERT ', 'DELETE ', 'TRUNCATE']) {
      expect(code(CENSUS), `в переписи появился ${verb.trim()}`).not.toContain(verb);
    }
  });
});

/**
 * Место без снимка — в самый конец витрины (решение владельца 20.09).
 *
 * ── Почему это сторожится, хотя «и так работало» ──────────────────────────
 *
 * До сегодня порядок выходил сам: ключ `has_real_image` стоял вторым, после
 * суммы полноты карточки, а сумма у МЕСТ всегда ноль — VIEW отдаёт им пустой
 * payload (миграция 942). То есть нужный порядок держался на свойстве чужих
 * данных, а не на правиле: появись у мест payload с ценой — и места без фото
 * молча всплыли бы наверх, причём заметить это было бы нечем.
 *
 * Вместе со снятием подстановки цена ошибки выросла: раньше у 226 мест из 378
 * карточка показывала кадр оператора, и «без фото» на витрине не существовало
 * как состояния. Теперь оно видно, и его место — в хвосте.
 */
describe('места без снимка уходят в хвост правилом, а не случайно', () => {
  const CATALOG_SRC = readFileSync(join(process.cwd(), 'lib/routes/catalog-query.ts'), 'utf-8');
  const CATALOG_CODE = code(CATALOG_SRC);

  /** Ветка `recommended` целиком — от неё и до следующей ветки сортировки. */
  const recommended = (() => {
    const at = CATALOG_CODE.indexOf("sort === 'recommended'");
    const end = CATALOG_CODE.indexOf("sort === 'navigable'", at);
    expect(at, 'ветка recommended не найдена').toBeGreaterThan(-1);
    return CATALOG_CODE.slice(at, end > -1 ? end : at + 2500);
  })();

  it('первым ключом идёт «место без снимка — вниз»', () => {
    const key = recommended.indexOf("ark.kind = 'place'");
    const richness = recommended.indexOf("payload->>'price_from'");
    expect(key, 'ключа про место без снимка нет вовсе').toBeGreaterThan(-1);
    expect(key, 'ключ стоит ПОСЛЕ суммы полноты — порядок снова зависит от payload')
      .toBeLessThan(richness);
  });

  it('правило показа берётся из общего источника, а не переписано литералом', () => {
    // Иначе в проекте стало бы два ответа на вопрос «какой снимок
    // показывается» — ровно то, что origin.ts и сводил в одно место.
    expect(recommended).toContain('shownPhotoSql');
    expect(recommended).not.toMatch(/model\s+IN\s*\(\s*'/i);
  });

  it('ключ касается только мест — маршрутам и турам порядок не меняли', () => {
    const at = recommended.indexOf("ark.kind = 'place'");
    expect(recommended.slice(at, at + 220)).toMatch(/THEN 1 ELSE 0 END ASC/);
  });
});
