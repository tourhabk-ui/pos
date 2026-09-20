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

  it('снимка нет, категория знакомая — подстановка оператора, а НЕ градиент', () => {
    // Ровно то, что перепись называла градиентом до 20.09.
    const r = cardImage({ hasShownPhoto: false, id: 'abc', category: 'termalnye_istochniki' });
    expect(r.kind).toBe('category_fallback');
    expect(r.url).toContain('/images/partners/kamchatintour/');
  });

  it('категория незнакомая — градиент, и адреса нет', () => {
    const r = cardImage({ hasShownPhoto: false, id: 'abc', category: 'нечто-своё' });
    expect(r.kind).toBe('gradient');
    expect(r.url).toBeNull();
  });

  it('категории нет вовсе — тоже градиент', () => {
    expect(cardImage({ hasShownPhoto: false, id: 'abc', category: null }).kind).toBe('gradient');
  });

  it('адрес из payload идёт вперёд подстановки и назван своим родом', () => {
    const r = cardImage({
      hasShownPhoto: false, id: 'abc', category: 'vulkani',
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
