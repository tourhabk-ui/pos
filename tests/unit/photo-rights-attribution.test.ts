/**
 * Права на чужое фото доезжают от загрузки до экрана.
 *
 * Повод предметный (14.09). Владелец разобрал условия ГВП и решил брать фото
 * вулканов напрямую у вулканологов — ИВиС ДВО РАН / КВЕРТ: снимки Камчатки на
 * volcano.si.edu помечены знаком охраны того же института («© ИВиС ДВО РАН,
 * КВЕРТ, Ю. Демянчук» на Figure 100 страницы Шивелуча), то есть public-domain
 * расчёт исходного плана для нашего региона не работал.
 *
 * Проверка приёмной стороны нашла ТРИ дефекта подряд, и каждый ломал ровно то,
 * ради чего лицензию и берут — видимое указание автора:
 *
 *  1. **Ручная загрузка не писала права ВООБЩЕ.** Колонки author/license/
 *     license_url/source_url в `ai_route_images` есть, вики-путь их заполняет,
 *     а `POST /api/admin/places/[id]/photo` не перечислял ни одной. Снимок,
 *     полученный у правообладателя, ложился в базу без следа того, чей он.
 *
 *  2. **UPSERT не обновлял права.** `ON CONFLICT DO UPDATE` перечислял
 *     image_data, mime_type, prompt, model, width, height — и НЕ author с
 *     license. Заменив снимок Wikimedia ручной загрузкой, строка сохраняла
 *     автора и лицензию ПРЕЖНЕГО фото: карточка подписывала новое изображение
 *     чужим именем и чужой лицензией.
 *
 *  3. **Подпись выдавалась только вики-фото.** Условие
 *     `photo_model === 'wikimedia'` означало, что снимок ручной загрузки не
 *     подписывался НИКОГДА — даже с заполненными автором и лицензией.
 *
 *  Плюс четвёртое, в разметке: `author || 'Wikimedia Commons'` ПРИПИСЫВАЛ
 *  безымянный снимок Wikimedia Commons. Под фото ИВиС это ложь вдвойне —
 *  чужое имя и намёк на свободную лицензию, которой нет (§4.0: место, где
 *  нельзя сказать «не знаю», заполняется враньём).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
/**
 * Код без комментариев. Проверки ниже судят о ТОМ, ЧТО ДЕЛАЕТСЯ, — а половина
 * комментариев в этих файлах как раз объясняет, что здесь стояло раньше и
 * почему убрано. Запрет на упоминание сделал бы объяснение невозможным
 * (этот же промах повторился сегодня трижды: сторож чужих навигаторов,
 * проверка geo: в плане поездки и первая редакция этого файла).
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const UPLOAD = read('app/api/admin/places/[id]/photo/route.ts');
const API = read('app/api/places/[id]/route.ts');
const VIEW = read('app/places/[id]/_PlaceDetailClient.tsx');
const VIEW_CODE = code(VIEW);

const RIGHTS = ['author', 'license', 'license_url', 'source_url'] as const;

describe('ручная загрузка записывает права', () => {
  it('все четыре поля перечислены в INSERT', () => {
    const at = UPLOAD.indexOf('INSERT INTO ai_route_images');
    expect(at, 'INSERT не найден').toBeGreaterThan(-1);
    const stmt = UPLOAD.slice(at, UPLOAD.indexOf('`,', at));
    const cols = stmt.slice(0, stmt.indexOf('VALUES'));
    for (const c of RIGHTS) expect(cols, `колонка ${c}`).toContain(c);
  });

  it('все четыре обновляются при замене снимка, а не остаются от прежнего', () => {
    // Самый тихий из трёх дефектов: фото новое, подпись старая.
    const at = UPLOAD.indexOf('ON CONFLICT (route_id) DO UPDATE');
    expect(at).toBeGreaterThan(-1);
    const upd = UPLOAD.slice(at, UPLOAD.indexOf('`,', at));
    for (const c of RIGHTS) {
      expect(upd, `${c} должен обновляться из EXCLUDED`).toMatch(
        new RegExp(`${c}\\s*=\\s*EXCLUDED\\.${c}`),
      );
    }
  });

  it('пустая строка формы — это отсутствие, а не «автор без имени»', () => {
    expect(UPLOAD).toMatch(/trimmed === '' \? null : /);
  });

  it('поля необязательны: у своего снимка внешнего автора нет', () => {
    // Требовать автора значило бы заставлять выдумывать его для собственных
    // фото. Признак необязательности — тип `string | null` у читателя полей и
    // отсутствие отказа при пустом значении.
    expect(UPLOAD).toMatch(/const rights = \(key: string\): string \| null =>/);
    const at = UPLOAD.indexOf('const rights =');
    const body = UPLOAD.slice(at, UPLOAD.indexOf('const author', at));
    expect(body).not.toContain('NextResponse.json');
    expect(body).not.toContain('status: 400');
  });

  it('записанное возвращается в ответе — загрузивший видит подпись сразу', () => {
    expect(UPLOAD).toMatch(/rights: \{ author, license, licenseUrl, sourceUrl \}/);
  });
});

describe('подпись следует за данными, а не за именем модели', () => {
  it('условие атрибуции не упоминает wikimedia', () => {
    const at = API.indexOf('photoAttribution:');
    expect(at).toBeGreaterThan(-1);
    const cond = API.slice(at, API.indexOf('? {', at));
    expect(cond, 'снимок ручной загрузки обязан подписываться так же')
      .not.toContain("'wikimedia'");
    expect(cond).toContain('r.photo_author || r.photo_license');
  });
});

describe('разметка не выдумывает автора', () => {
  it('Wikimedia Commons больше не подставляется по умолчанию', () => {
    // В КОДЕ имени быть не должно; в комментарии оно есть и объясняет, что
    // здесь стояло до 14.09 и чем это было плохо.
    expect(VIEW_CODE).not.toContain('Wikimedia Commons');
    expect(VIEW).toContain('Wikimedia Commons');
  });

  it('автор рисуется, только если он известен', () => {
    expect(VIEW_CODE).toMatch(/\{place\.photoAttribution\.author && \(/);
  });

  it('разделитель не висит, когда автора нет', () => {
    // «Фото: · CC BY 4.0» — след выдуманного поля; точка ставится только
    // между двумя существующими частями.
    expect(VIEW_CODE).toMatch(/\{place\.photoAttribution\.author \? ' · ' : ''\}/);
  });
});
