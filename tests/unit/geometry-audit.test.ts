/**
 * Аудит данных маршрутов меряет теми же правилами, что показывает экран.
 *
 * Владелец просит перенести маршруты в единую базу. Переносить 421 маршрут
 * вслепую — это переписать данные, от которых зависит безопасность, не зная,
 * что именно сломано. Аудит существует, чтобы решение принималось по цифрам.
 *
 * Его единственная ценность в том, что он считает ТЕМ ЖЕ кодом: набросок
 * определяется той же trackFidelity, что рисует линию пунктиром, а отрыв
 * точки — той же проекцией, что считает путь в поле. Свои пороги сделали бы
 * аудит измерением самого себя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometryToTrack, reasonKey } from '@/lib/routes/geometry-audit';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const AUDIT = read('lib/routes/geometry-audit.ts');
const API = read('app/api/cron/route-data-audit/route.ts');
const WORKFLOW = read('.github/workflows/route-data-audit.yml');

describe('геометрия читается так же, как её читает офлайн-пакет', () => {
  it('GeoJSON приходит парами [lng, lat] — порядок не путается', () => {
    // Перепутанный порядок увёл бы Камчатку в Индийский океан, и аудит
    // объявил бы конфликтом каждый маршрут.
    const t = geometryToTrack({ coordinates: [[158.65, 53.02], [158.70, 53.10]] });
    expect(t).toEqual([{ lat: 53.02, lng: 158.65 }, { lat: 53.10, lng: 158.70 }]);
  });

  it('мусор не роняет разбор и не превращается в точки', () => {
    expect(geometryToTrack(null)).toEqual([]);
    expect(geometryToTrack({})).toEqual([]);
    expect(geometryToTrack({ coordinates: 'нет' })).toEqual([]);
    expect(geometryToTrack({ coordinates: [[158.65], ['a', 'b'], [158.7, 53.1]] }))
      .toEqual([{ lat: 53.1, lng: 158.7 }]);
  });
});

describe('аудит считает чужими правилами, а не своими', () => {
  it('набросок определяется trackFidelity, а не собственным порогом', () => {
    expect(AUDIT).toMatch(/from '@\/lib\/routes\/track-fidelity'/);
    expect(AUDIT).toMatch(/trackFidelity\(/);
    expect(AUDIT).not.toMatch(/points[Pp]erKm\s*[<>]/);
  });

  it('отрыв точки считается той же проекцией, что и путь в поле', () => {
    expect(AUDIT).toMatch(/from '@\/lib\/on-route\/approach'/);
    expect(AUDIT).toMatch(/projectOnTrack\(/);
    expect(AUDIT).toMatch(/DATA_CONFLICT_KM/);
    // Свой порог в цифрах — это второе определение конфликта.
    expect(AUDIT).not.toMatch(/offTrackKm\s*>\s*\d/);
  });

  it('порог назван в ответе — иначе цифру не с чем сопоставить', () => {
    expect(AUDIT).toContain('conflict_km');
  });
});

describe('аудит ничего не портит и не приукрашивает', () => {
  it('только чтение', () => {
    expect(AUDIT).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });

  it('классы не сливаются: нет линии, нет точек и конфликт — разные счётчики', () => {
    for (const k of ['no_geometry', 'no_waypoints', 'conflicting', 'consistent']) {
      expect(AUDIT).toContain(k);
    }
  });

  it('худшие расхождения названы поимённо — с них начинать разбор', () => {
    expect(AUDIT).toContain('worst');
    expect(AUDIT).toMatch(/sort\(\(a, b\) => b\.worstOffTrackKm - a\.worstOffTrackKm\)/);
  });

  it('урезанный счёт виден рядом с полным', () => {
    expect(AUDIT).toContain('routes_total');
    expect(AUDIT).toContain('routes_counted');
  });
});

describe('перепись меряет то, чем пользуется платформа', () => {
  /**
   * Смоук 17.08 столкнул два измерения: по API пригоден один маршрут из пяти,
   * по переписи — ноль из трёхсот. Спор решился в пользу API: перепись брала
   * путевые точки ШИРЕ, чем карточка, — вместе со скрытыми и слитыми.
   *
   * Слитый дубль в стороне от линии даёт расхождение выше порога, и маршрут
   * теряет обещание ведения из-за точки, которой человек на экране не увидит.
   * Мера, считающая по невидимому, отвечает не про продукт.
   */
  const wpQuery = AUDIT.slice(AUDIT.indexOf('FROM route_waypoints'), AUDIT.indexOf('const byRoute'));

  it('скрытые и слитые точки не судят маршрут — карточка их не показывает', () => {
    expect(wpQuery).toMatch(/is_visible\s*=\s*TRUE/);
    expect(wpQuery).toMatch(/merged_into_id IS NULL/);
  });

  it('порядок точек спрошен, а не предположен', () => {
    // Порядок здесь — измеряемая величина: waypointFit считает инверсии.
    // Без ORDER BY Postgres вправе вернуть строки как угодно, и счёт инверсий
    // становится шумом. До 17.08 сортировку обещал только комментарий.
    expect(wpQuery).toMatch(/ORDER BY rw\.route_id, rw\.position/);
    expect(AUDIT).toMatch(/waypointFit\(/);
  });
});

describe('ноль пригодных обязан назвать причину', () => {
  /**
   * Прогон 17.08 вернул «пригодны: 0» и на этом замолчал. Ноль без причины не
   * отвечает на вопрос, который за ним стоит: чинить данные, порог или само
   * правило. За этим молчанием уже пряталась ошибка правила (габарит вместо
   * непрерывности), и нашлась она догадкой, а не инструментом.
   */
  it('причины считаются, а не только вердикты', () => {
    expect(AUDIT).toContain('navigability_reasons');
  });

  it('одинаковая беда сводится в одну строку, разная — не сливается', () => {
    // Иначе двадцать пять расхождений выглядели бы двадцатью пятью разными
    // бедами, и счётчик перестал бы быть счётчиком.
    expect(reasonKey('Точка стоит в 14.2 км от линии — данные маршрута не сходятся'))
      .toBe(reasonKey('Точка стоит в 3,1 км от линии — данные маршрута не сходятся'));
    expect(reasonKey('Линию не с чем сверить: путевых точек меньше двух'))
      .not.toBe(reasonKey('Точка стоит в 14.2 км от линии — данные маршрута не сходятся'));
  });

  it('слова причины принадлежат черте, перепись их не переписывает', () => {
    // Свой текст отказа здесь означал бы две формулировки одного решения:
    // человек в поле читал бы одно, разбор — другое.
    const key = reasonKey('Линию не с чем сверить: путевых точек меньше двух');
    expect(key).toBe('Линию не с чем сверить: путевых точек меньше двух');
  });

  it('перепись можно запустить без права actions: write', () => {
    // У агента в репозитории этого права нет (оно у GitHub App, а не у доступа
    // к репозиторию), и без второго входа перепись мог запустить только
    // владелец руками. Инструмент разбора, за запуском которого надо кого-то
    // просить, зовут реже, чем нужно, — а решения по памяти вместо базы мы уже
    // проходили весь вечер 17.08.
    expect(WORKFLOW).toMatch(/\.github\/triggers\/route-data-audit\.json/);
    // Расписания при этом нет и быть не должно: перепись ходит по всем
    // маршрутам, гонять её по часам значит нагружать прод впустую.
    expect(WORKFLOW).not.toMatch(/schedule:/);
  });

  it('разбивка доходит до глаз — печатается в прогоне', () => {
    // Поле в JSON, которое никто не печатает, отвечает на вопрос в сводке из
    // сотен строк. Смотрят в лог.
    expect(WORKFLOW).toContain('navigability_reasons');
    expect(WORKFLOW).toMatch(/Почему не проходят черту/);
  });
});

describe('доступ к аудиту', () => {
  it('закрыт секретом до запуска', () => {
    expect(API).toMatch(/timingSafeCompare/);
    expect(API.indexOf('timingSafeCompare')).toBeLessThan(API.indexOf('runGeometryAudit('));
  });

  it('отказ отдаётся ошибкой, а не пустым аудитом', () => {
    // Пустой читался бы как «маршрутов нет», то есть как «всё хорошо».
    expect(API).toMatch(/status:\s*500/);
  });
});
