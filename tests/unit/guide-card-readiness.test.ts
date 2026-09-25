/**
 * Готовность гида к AI-визитке: правило, перепись и её честность.
 *
 * ── Разбор 19.09 (#1926) ───────────────────────────────────────────────────
 *
 * Находка просит дать гидам публичную страницу с ассистентом, отвечающим
 * «строго на данных партнёра из его профиля и маршрутов». Проверка предпосылки
 * дала две вещи, и одна из них — моя собственная ошибка.
 *
 * ОШИБКА. 18.09 я написал в разборе той же находки: «партнёрской области
 * видимости у Кузьмича нет, её надо заводить, оценка medium занижена». Область
 * ЕСТЬ и работает: `lib/kuzmich/operator-chat.ts` отвечает оператору про его
 * туры, его брони за неделю и его предстоящие, отбирая по `operator_id` в
 * каждом запросе. Устроена она при этом не ограничением инструментов (их в том
 * пути нет вовсе), а предзагрузкой партнёрского контекста в промпт.
 *
 * НАСТОЯЩИЙ ПРОБЕЛ в другом: чем ассистент будет отвечать. У гидов НЕТ своих
 * туров — они принадлежат оператору (`operator_tours.operator_id`), а гид
 * связан с ним полем `partners.guide_operator_id`. Сколько гидов привязано, не
 * считала ни одна перепись. Отсюда эта.
 *
 * ── Чего сторож не позволит ────────────────────────────────────────────────
 *
 *  - перепись начать писать в базу (объявлена read-only — значит и остаётся);
 *  - правилу обзавестись выдуманным порогом длины описания: у туров он есть и
 *    взят у Editor'а, а для профиля гида такого числа в платформе нет, и
 *    придумать его значило бы записать решение там, где его не принимали;
 *  - контексту ассистента когда-нибудь унести на публичную страницу имена
 *    туристов из партнёрского чата — это 152-ФЗ и гард D1, а не предпочтение.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockingGaps,
  contentSignals,
  type GuideReadinessRow,
} from '@/lib/guides/card-readiness';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = 'app/api/cron/guide-readiness/route.ts';
const ROUTE_SRC = read(ROUTE);

/**
 * Комментарии вырезаны. Иначе сторож ловил бы СОБСТВЕННОЕ обещание роута
 * («ни UPDATE, ни INSERT здесь нет») и краснел на честном файле — а вместе с
 * тем приучал бы убирать из шапок именно те слова, ради которых шапка и
 * написана.
 */
const ROUTE_CODE = ROUTE_SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const RULE_SRC = read('lib/guides/card-readiness.ts');

const guide = (over: Partial<GuideReadinessRow> = {}): GuideReadinessRow => ({
  id: '1',
  name: 'Иван Петров',
  operator_id: 'op-7',
  operator_name: 'Камчатка-Тур',
  operator_active_tours: 2,
  description_chars: 180,
  verified_certs: 1,
  public_reviews: 3,
  has_photo: true,
  languages_count: 2,
  specializations_count: 1,
  ...over,
});

describe('что блокирует визитку — следует из решений владельца', () => {
  it('гид со всем необходимым не блокируется', () => {
    expect(blockingGaps(guide())).toEqual([]);
  });

  it('не привязан к оператору — заявку отдать некому', () => {
    // Решение владельца 19.09: заявка со страницы гида принадлежит оператору,
    // к которому гид привязан. Без привязки механизма нет вовсе.
    expect(blockingGaps(guide({ operator_id: null, operator_name: null, operator_active_tours: 0 })))
      .toEqual(['operator_not_linked']);
  });

  it('привязан, но у оператора нет активных туров — продавать нечего', () => {
    expect(blockingGaps(guide({ operator_active_tours: 0 })))
      .toEqual(['operator_has_no_active_tours']);
  });

  it('две причины не смешиваются в одну', () => {
    // Непривязанный гид не обвиняется ЕЩЁ И в том, что у несуществующего
    // оператора нет туров: это одна беда, названная дважды, и в счёте по
    // пробелам она удвоила бы работу.
    const gaps = blockingGaps(guide({ operator_id: null, operator_name: null, operator_active_tours: 0 }));
    expect(gaps).not.toContain('operator_has_no_active_tours');
  });

  it('пустое описание блокирует: иначе ассистенту останется выдумать', () => {
    // §4.0, случай Ключевской: требование, которое нечем выполнить,
    // выполняется выдумкой.
    expect(blockingGaps(guide({ description_chars: 0 }))).toEqual(['description_empty']);
  });

  it('короткое описание НЕ блокирует — порога у профиля гида нет', () => {
    expect(blockingGaps(guide({ description_chars: 12 }))).toEqual([]);
  });

  it('аттестаты, отзывы и фото не блокируют, но считаются', () => {
    const bare = guide({ verified_certs: 0, public_reviews: 0, has_photo: false,
                         languages_count: 0, specializations_count: 0 });
    expect(blockingGaps(bare)).toEqual([]);
    expect(contentSignals(bare)).toEqual([]);
    expect(contentSignals(guide())).toEqual(['certs', 'reviews', 'photo', 'languages', 'specializations']);
  });
});

describe('порог длины описания не выдуман', () => {
  it('в правиле нет числового порога знаков', () => {
    // У туров порог есть (300, по нему работает Editor). Для профиля гида
    // такого числа в платформе нет. Появится — будет решением владельца,
    // а не побочным эффектом правки.
    expect(RULE_SRC).not.toMatch(/description_chars\s*<\s*\d+/);
    expect(RULE_SRC).not.toMatch(/MIN_[A-Z_]*DESCRIPTION[A-Z_]*\s*=/);
  });

  it('блокирует ровно ноль знаков, а не «мало»', () => {
    expect(RULE_SRC).toMatch(/description_chars === 0/);
  });

  it('перепись отдаёт распределение длин вместо приговора', () => {
    expect(ROUTE_SRC).toContain('description_chars: {');
    expect(ROUTE_SRC).toMatch(/median/);
    expect(ROUTE_SRC).toMatch(/note:/);
  });
});

describe('перепись только читает', () => {
  it('ни UPDATE, ни INSERT, ни DELETE в роуте нет', () => {
    // Объявлена read-only — значит и остаётся. Возможность появляется тихо:
    // одна строка UPDATE в файле, который «и так про базу», в диффе выглядит
    // обычной правкой.
    for (const verb of ['UPDATE ', 'INSERT ', 'DELETE ', 'TRUNCATE']) {
      expect(ROUTE_CODE, `в переписи появился ${verb.trim()}`).not.toContain(verb);
    }
  });

  it('метода POST у роута нет', () => {
    expect(ROUTE_CODE).not.toMatch(/export async function POST/);
  });

  it('секрет проверяется постоянным по времени сравнением', () => {
    expect(ROUTE_SRC).toContain('timingSafeCompare');
    expect(ROUTE_SRC).toContain('getCronSecret');
  });

  it('отказ запроса не выдаётся за «гидов нет»', () => {
    const tail = ROUTE_SRC.slice(ROUTE_SRC.lastIndexOf('} catch'));
    expect(tail).toContain('console.error');
    expect(tail).toContain('status: 500');
  });

  it('ноль живых гидов — отказ переписи, а не «все готовы»', () => {
    expect(ROUTE_SRC).toMatch(/meaningful: rows\.length > 0/);
  });
});

describe('отбор гидов тот же, которым живёт сама страница', () => {
  it('перепись судит ровно тех, кого показывает сайт', () => {
    // Своя копия условия показывала бы готовность тех, кого на сайте нет.
    // До 25.09 этот тест требовал в обоих местах `profile_status = 'active'`
    // — значения, которого CHECK колонки не допускает: сторож держал
    // одинаковость двух копий и потому зеленел, пока обе отбирали ноль.
    // Теперь условие одно — publicGuideWhere (lib/guides/visibility.ts), и
    // требуется ровно его вызов, без собственных копий.
    const page = read('app/guides/[id]/page.tsx');
    for (const [name, src] of [['страница', page], ['перепись', ROUTE_SRC]] as const) {
      expect(src, name).toMatch(/publicGuideWhere\('(p|g)'\)/);
      expect(src, name).not.toMatch(/\b[pg]\.profile_status\s*=/);
    }
  });

  it('туры считаются у ПРИВЯЗАННОГО оператора, а не у любого', () => {
    expect(ROUTE_SRC).toMatch(/t\.operator_id = g\.guide_operator_id/);
    expect(ROUTE_SRC).toMatch(/t\.is_active = TRUE AND t\.deleted_at IS NULL/);
  });
});

describe('персональные данные туристов на публичный путь не уходят', () => {
  it('перепись не читает ни имён туристов, ни броней', () => {
    // Контекст партнёрского чата (operator-chat) содержит ob.tourist_name.
    // Скопировать этот шаблон на публичную страницу нельзя ни при каком
    // решении владельца: §8, гард D1, 152-ФЗ.
    for (const field of ['tourist_name', 'tourist_phone', 'operator_bookings']) {
      expect(ROUTE_SRC, `перепись читает ${field}`).not.toContain(field);
    }
  });

  it('в партнёрском чате оператора имена туристов ЕСТЬ — и это его граница', () => {
    // Тест фиксирует факт, из которого следует запрет выше. Пропадёт он —
    // значит переписали operator-chat, и запрет надо перечитать заново.
    expect(read('lib/kuzmich/operator-chat.ts')).toContain('tourist_name');
  });
});
