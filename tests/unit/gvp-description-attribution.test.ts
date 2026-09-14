/**
 * Подпись источника под описанием места (#1830, шаг 4).
 *
 * 13.09 в `places.description` легли 23 текста, переведённых с Remarks
 * Смитсоновского института. Владелец потребовал видимую пометку: научный
 * источник отвечает за содержание, мы — только за перевод, и человеку это
 * различие нужно видеть там, где он читает.
 *
 * ЧТО СТОРОЖ ДЕРЖИТ И ПОЧЕМУ ИМЕННО ЭТО.
 *
 * 1. **Подпись привязана к ТЕКСТУ, а не к месту.** `places.source_url` /
 *    `source_name` говорят о происхождении ЗАПИСИ и на экран не выводятся
 *    намеренно (решение владельца 17.08, §4.1). Здесь другое поле и другой
 *    смысл; смешать их значило бы вернуть на экран то, что оттуда убрали.
 *
 * 2. **Равенство текстов в JOIN.** Черновик остаётся `approved` навсегда, а
 *    описание потом может переписать кто угодно — Editor, миграция, человек в
 *    админке. Подпись «по данным Смитсоновского института» под чужим текстом
 *    — ложное утверждение об источнике, и хуже отсутствия подписи. Условие
 *    `translated_text = p.description` снимает подпись САМО, без чьей-либо
 *    памяти о том, что так надо.
 *
 * 3. **Ссылка появилась только после проверки ЧЕЛОВЕКОМ.** Проба 499 (13.09)
 *    получила HTTP 403 на все три адреса volcano.si.edu и si.edu —
 *    Смитсоновский закрывает датацентр, — поэтому сперва подпись шла текстом
 *    без ссылки: непроверенный путь на карточке был бы обещанием дороги,
 *    которой мы не видели. 14.09 адрес подтвердил владелец из браузера, и
 *    «не смог» стало «работает». Сторож держит ОБА исхода: ссылка есть, когда
 *    опознание адресуемо, и её нет, когда нет.
 *
 * 4. **Формулировка одна на платформу.** Две подписи под одним источником
 *    стали бы двумя разными утверждениями о нём — тот же урок, что у линий
 *    карты (§12) и у подсказки избранного.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDescriptionSource } from '@/lib/text/description-source';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const API = read('app/api/places/[id]/route.ts');
const MODULE = read('lib/text/description-source.ts');
const VIEW = read('components/places/PlaceDescription.tsx');
const CLIENT = read('app/places/[id]/_PlaceDetailClient.tsx');

describe('describeDescriptionSource — чистая логика', () => {
  it('нет опознания — нет подписи; пробелы считаются отсутствием', () => {
    // Пустая строка и строка из пробелов — одно и то же «опознания нет».
    // Разное поведение у них было бы разнобоем на ровном месте.
    for (const ref of [null, undefined, '', '   ', '\t']) {
      expect(describeDescriptionSource(ref), JSON.stringify(ref)).toBeNull();
    }
  });

  it('есть VolcanoNumber — подпись дословно из issue', () => {
    const src = describeDescriptionSource('300270');
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('gvp');
    expect(src!.label).toBe('По данным Global Volcanism Program, Смитсоновский институт');
  });

  it('полное имя института, не аббревиатура', () => {
    // «ГВП» человеку в поле не говорит ничего, а подпись ставится ради него.
    const src = describeDescriptionSource('300270')!;
    expect(src.label).toContain('Смитсоновский институт');
    expect(src.label).not.toMatch(/\bГВП\b/);
  });

  it('шестизначный номер — адрес страницы вулкана', () => {
    // Ровно тот адрес, который владелец открыл из браузера 14.09.
    expect(describeDescriptionSource('300270')!.url)
      .toBe('https://volcano.si.edu/volcano.cfm?vn=300270');
    // Пробелы по краям не должны попадать в адрес.
    expect(describeDescriptionSource(' 300270 ')!.url)
      .toBe('https://volcano.si.edu/volcano.cfm?vn=300270');
  });

  it('опознание не шестизначное — ссылки нет, а подпись остаётся', () => {
    // Битая ссылка хуже её отсутствия: подпись называет источник и текстом.
    for (const ref of ['Sheveluch', '30027', '3002701', 'vn=300270']) {
      const src = describeDescriptionSource(ref);
      expect(src, ref).not.toBeNull();
      expect(src!.url, ref).toBeNull();
      expect(src!.label, ref).toBe('По данным Global Volcanism Program, Смитсоновский институт');
    }
  });

  it('история проверки записана: 403 с раннера и подтверждение человеком', () => {
    // Без этой записи следующий, увидев 403 в логах пробы, решит, что ссылка
    // сломана, и снимет рабочий адрес.
    expect(MODULE).toMatch(/403/);
    expect(MODULE).toMatch(/подтвердил владелец из браузера/);
  });

  it('лицензия фото НЕ следует из того, что страница открылась', () => {
    // «Скачивается» и «можно публиковать на коммерческой странице» — разные
    // утверждения; VPImageCredit это подпись автора, а не условия.
    expect(MODULE).toMatch(/ЛИЦЕНЗИЯ ФОТО ЭТИМ НЕ ЗАКРЫТА/);
  });
});

describe('API отдаёт подпись только пока текст не разошёлся с переводом', () => {
  it('JOIN требует approved-черновик ГВП И посимвольное совпадение', () => {
    const at = API.indexOf('LEFT JOIN place_description_drafts gvp');
    expect(at, 'JOIN черновика не найден').toBeGreaterThan(-1);
    const join = API.slice(at, at + 400);
    expect(join).toContain("gvp.source = 'gvp'");
    expect(join).toContain("gvp.status = 'approved'");
    expect(join, 'без сравнения текстов подпись переживёт переписанное описание')
      .toContain('gvp.translated_text = p.description');
  });

  it('в ответе отдельное поле, не смешанное с источником ЗАПИСИ места', () => {
    expect(API).toMatch(/descriptionSource: describeDescriptionSource\(r\.description_source_ref/);
    // Источник записи остаётся как был — своим полем и своим смыслом.
    expect(API).toMatch(/sourceName: r\.source_name/);
  });
});

describe('подпись доходит до экрана', () => {
  it('карточка передаёт её в блок описания', () => {
    expect(CLIENT).toMatch(/descriptionSource=\{place\.descriptionSource\}/);
  });

  it('рисуется под текстом, которому относится, и только при наличии', () => {
    expect(VIEW).toMatch(/\{descriptionSource && \(/);
    expect(VIEW).toMatch(/\{descriptionSource\.label\}/);
    // Приглушённо: это сноска, а не часть рассказа о месте.
    expect(VIEW).toMatch(/text-\[var\(--text-muted\)\]/);
  });

  it('ссылка — только когда адрес есть; иначе тот же текст без неё', () => {
    expect(VIEW).toMatch(/descriptionSource\.url \? \(/);
    expect(VIEW).toMatch(/href=\{descriptionSource\.url\}/);
    expect(VIEW).toMatch(/\) : descriptionSource\.label\}/);
    // Чужая вкладка и без передачи реферера — как у остальных внешних ссылок.
    expect(VIEW).toMatch(/rel="noopener noreferrer"/);
    // Адрес в разметке не зашит: он строится из VolcanoNumber в одном месте.
    expect(VIEW).not.toContain('volcano.si.edu');
  });
});
