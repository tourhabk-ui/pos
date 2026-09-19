/**
 * Сторож: выбор маршрута В ПОЛЕ идёт по роду линии, а не по красоте карточки.
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * 19.09 владелец с телефона: «сменить маршрут работает криво, откуда-то берёт
 * ужасно кривые маршруты, а когда выбираешь точку на карте — механизм
 * построения другой и он неплох». На вопрос, какой именно маршрут кривой:
 * «да любой».
 *
 * Два механизма там и вправду разные. Выбор точки на карте НИЧЕГО готового не
 * берёт: координаты уходят на сервер, и A* считает путь по нашему дорожному
 * графу. Кнопка «Сменить маршрут» не считает ничего — это витрина каталога.
 *
 * Витрина ранжировалась сортировкой `recommended`: цена, сложность,
 * длительность, месяцы, фото, длина описания. Про род линии — ни слова. А
 * перепись каталога того же дня (389 живых маршрутов): скрейп с чужих сайтов
 * 252, линии нет вовсе 103, набросок 10, построение A* 2 — и только 22 снятых
 * трека. При таком составе сортировка по красоте текста почти наверняка
 * поднимает наверх линию, по которой никто не ходил.
 *
 * Это §12 в чистом виде: линия — обещание, и первым предлагать надо то, чему
 * можно верить. Ничего не прячется: маршрут без линии остаётся в выдаче со
 * своим бейджем, он просто перестаёт быть первым предложением.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Связку целиком, а не половину: порядок собирается ИЗ реестров §12, полевой
 * экран просит именно его, и вшивание имён в SQL безопасно по построению.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINE_RANK,
  lineRankSql,
  SYNTHETIC_SOURCES,
  UNVERIFIED_SOURCES,
} from '@/lib/map/line-standard';
import { CatalogQuerySchema } from '@/lib/routes/catalog-query';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('порядок родов линии', () => {
  it('снятый трек раньше наброска, набросок раньше непроверенной, линии нет — последней', () => {
    // Это и есть ответ на вопрос человека на тропе: чему можно верить.
    expect(LINE_RANK.surveyed).toBeLessThan(LINE_RANK.sketch);
    expect(LINE_RANK.sketch).toBeLessThan(LINE_RANK.unknown);
    expect(LINE_RANK.unknown).toBeLessThan(LINE_RANK.no_line);
  });

  it('SQL собирается из реестров, а не переписывает их', () => {
    const sql = lineRankSql('krl.geometry');
    // Каждый известный слог обязан быть в выражении. Забытый — это второй
    // реестр, расходящийся с первым: ровно тот класс, что §12 и называет.
    for (const s of [...SYNTHETIC_SOURCES]) expect(sql).toContain(`'${s}'`);
    // Снятые источники реестром не экспортируются, поэтому проверяем поимённо
    // те, что стандарт называет в своей шапке.
    for (const s of ['osm', 'visitkamchatka', 'kml_inbox', 'gpx', 'osm-trace']) {
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toContain('krl.geometry IS NULL');
  });

  it('непроверенный источник не попадает в ветку снятых', () => {
    const sql = lineRankSql('g');
    const surveyedBranch = sql.split('THEN ' + LINE_RANK.surveyed)[0];
    for (const s of [...UNVERIFIED_SOURCES]) {
      expect(surveyedBranch).not.toContain(`'${s}'`);
    }
  });

  it('незаписанный источник идёт как непроверенный, а не как трек', () => {
    // Плотность точек — догадка. Для ВИДА линии она допустима (рядом есть
    // слова), для очерёдности предложения — нет: догадка подняла бы линию
    // неизвестного происхождения выше записанного наброска.
    const sql = lineRankSql('g');
    expect(sql).toMatch(new RegExp(`ELSE\\s+${LINE_RANK.unknown}`));
  });
});

describe('предикат безопасен по построению', () => {
  it('слоги источников — только латиница, цифры, дефис и подчёркивание', () => {
    // На этом и только на этом держится право вшивать список в текст запроса.
    for (const s of [...SYNTHETIC_SOURCES, ...UNVERIFIED_SOURCES]) {
      expect(s).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
    expect(lineRankSql('krl.geometry')).not.toContain(';');
  });
});

describe('каталог умеет эту очерёдность', () => {
  it('сортировка navigable принимается схемой', () => {
    expect(CatalogQuerySchema.parse({ sort: 'navigable' }).sort).toBe('navigable');
  });

  it('ветка navigable ставит род линии ПЕРВЫМ ключом', () => {
    // Вторым ключом — полнота карточки: внутри одного рода маршрут с ценой и
    // сроками полезнее безымянного. Но первым — только линия.
    const src = read('lib/routes/catalog-query.ts');
    const branch = src.split("sort === 'navigable' ?")[1] ?? '';
    const head = branch.slice(0, 400);
    expect(head).toContain('lineRankSql');
    expect(head.indexOf('lineRankSql')).toBeLessThan(head.indexOf('cardRichness'));
  });

  it('порядок берётся из стандарта линии, а не собирается на месте', () => {
    const src = read('lib/routes/catalog-query.ts');
    expect(src).toContain("from '@/lib/map/line-standard'");
    // Свой CASE по источникам прямо в тексте каталога — начало расхождения.
    expect(src).not.toMatch(/WHEN[^\n]*'waypoints_synthetic'/);
  });
});

describe('полевой экран просит именно её', () => {
  const src = read('app/planning/_PlanningClient.tsx');

  it('оба списка маршрутов грузятся с sort=navigable', () => {
    // Сторож поздний по природе: правило живёт на сервере, а сломать его
    // можно одной строкой здесь — вернув sort=recommended.
    //
    // Списка два — «Сменить маршрут» в поле и маршруты на вкладке
    // планирования. Выбранный дома маршрут завтра проходят теми же ногами,
    // поэтому очерёдность у них одна, и проверяются оба разом.
    //
    // Считаются именно АДРЕСА запросов, а не упоминания слова: в соседнем
    // комментарии объяснено, почему сортировка сменилась, и счёт по слову
    // ломался бы от любой правки текста.
    const urls = src.match(/\/api\/routes\?[^'"`]+/g) ?? [];
    const listUrls = urls.filter(u => u.includes('kind=route'));
    expect(listUrls.length).toBe(2);
    for (const u of listUrls) expect(u).toContain('sort=navigable');
    expect(src).not.toContain('sort=recommended');
  });

  it('список по-прежнему требует реальных путевых точек', () => {
    // has_waypoints отсекает статьи-обзоры без единой точки. Новая сортировка
    // его не отменяет: это разные вопросы — «есть ли точки» и «чего стоит
    // линия».
    expect(src).toContain('has_waypoints=true');
  });

  it('бейдж рода линии остаётся на карточке списка', () => {
    // Очерёдность помогает выбрать, но не заменяет слова: человек обязан
    // видеть, чем является линия, а не только то, что она первая.
    expect(src).toContain('<GradeChip grade={r.lineGrade} />');
  });
});
