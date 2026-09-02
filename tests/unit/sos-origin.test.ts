/**
 * У SOS-сигнала есть третий исход — и в источнике, и в судьбе.
 *
 * ── Случай 02.09 ───────────────────────────────────────────────────────────
 *
 * В канал владельца пришло: «SOS! ЭКСТРЕННЫЙ СИГНАЛ. Имя: не указано. Тел:
 * не указан. Координаты: нет координат. Тип: не указан. IP: 74.235.134.163»
 * — адрес дата-центра в США. Сигнал лёг активным, и Watchdog с этой минуты
 * каждые полчаса требовал звонить 112 по поводу, о котором неизвестно даже,
 * человек ли его послал. Не впервые: миграция 123 закрывала РУКАМИ такой же
 * анонимный сигнал, провисевший 22 дня.
 *
 * Разбор нашёл вторую половину, и она хуже. `/api/cron/sos-events-bridge`
 * через 24 часа без ответа писал `status = 'resolved'` — «с человеком всё в
 * порядке» — тогда как означало это обратное: сутки никто не пришёл. Самый
 * громкий из возможных отказов записывался как успех, и Watchdog про него
 * навсегда замолкал.
 *
 * Два дефекта противоположны по направлению — шум и тишина, — но корень
 * один: у сигнала два состояния там, где нужно три. Сказать «не знаю»
 * системе было нечем, и она говорила «всё хорошо» (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifySosOrigin, needsEscalation, ORIGIN_WORDS,
  type SosOriginEvidence,
} from '@/lib/safety/sos-origin';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const EMPTY: SosOriginEvidence = {
  userId: null, secFetchSite: null, referer: null, userAgent: null,
  source: 'direct', sessionId: null,
  lat: null, lng: null,
  touristName: null, touristPhone: null, emergencyType: null, message: null,
};

describe('живой случай 02.09', () => {
  it('слепая проба эндпоинта: источник не установлен', () => {
    const m = classifySosOrigin({ ...EMPTY, userAgent: 'curl/8.5.0' });
    expect(m.klass).toBe('unattributed');
  });

  it('«не установлен» — не «ложная тревога»: слова этого не говорят', () => {
    // Соблазн написать «похоже на пробу» велик, но это уже догадка, а
    // решение принимает человек. Сигнал остаётся висеть.
    const w = ORIGIN_WORDS.unattributed;
    expect(w).not.toMatch(/ложн|подделк|бот|спам/i);
    expect(w).toMatch(/НЕ УСТАНОВЛЕН/);
    expect(w).toMatch(/не закрывать молча/);
  });
});

describe('человек без GPS не должен попасть в «неизвестные»', () => {
  // Главный риск всей затеи. Наша страница /sos при отказе спутников и
  // незаполненных полях шлёт РОВНО ТАКОЕ ЖЕ тело, что и проба:
  // { lat: null, lng: null, accuracy: null, tourist_name: null,
  //   tourist_phone: null }. По содержимому их не различить, поэтому
  // содержимое и не судит — судит происхождение запроса.

  it('пустое тело из браузера с нашей страницы — сигнал из приложения', () => {
    const m = classifySosOrigin({
      ...EMPTY,
      secFetchSite: 'same-origin',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
    });
    expect(m.klass).toBe('from_app');
    expect(needsEscalation(m.klass)).toBe(true);
  });

  it('старый браузер без Sec-Fetch-Site: хватает Referer с нашего хоста', () => {
    const m = classifySosOrigin({ ...EMPTY, referer: 'https://vedarai.ru/sos' });
    expect(m.klass).toBe('from_app');
  });

  it('чужой Referer за наш не считается', () => {
    const m = classifySosOrigin({ ...EMPTY, referer: 'https://vedarai.ru.evil.example/sos' });
    expect(m.klass).toBe('unattributed');
  });

  it('кривой Referer не роняет разбор и признаком не становится', () => {
    expect(classifySosOrigin({ ...EMPTY, referer: 'не-ссылка' }).klass).toBe('unattributed');
  });

  it('меш-ретрансляция: браузерных заголовков нет по построению', () => {
    // Форвардит наш же серверный роут — Sec-Fetch-Site там не будет никогда.
    const m = classifySosOrigin({ ...EMPTY, source: 'mesh_relay' });
    expect(m.klass).toBe('from_app');
  });

  it('авторизован — знаем, кто', () => {
    expect(classifySosOrigin({ ...EMPTY, userId: 'u-1' }).klass).toBe('authenticated');
  });

  it('одних координат достаточно, даже мимо приложения', () => {
    const m = classifySosOrigin({ ...EMPTY, lat: 53.25, lng: 158.65 });
    expect(m.klass).toBe('has_content');
    expect(needsEscalation(m.klass)).toBe(true);
  });

  it('пробелы содержанием не считаются', () => {
    const m = classifySosOrigin({ ...EMPTY, touristName: '   ', message: '' });
    expect(m.klass).toBe('unattributed');
  });

  it('широта без долготы координатой не считается', () => {
    // Половина пары никуда не ведёт, а «координаты есть» сказала бы неправду.
    expect(classifySosOrigin({ ...EMPTY, lat: 53.25 }).klass).toBe('unattributed');
  });
});

describe('«не с Камчатки» — только по координатам', () => {
  it('координаты за краем названы признаком', () => {
    // Москва: человек по ним находится, но искать будет не камчатское МЧС.
    const m = classifySosOrigin({ ...EMPTY, lat: 55.75, lng: 37.61 });
    expect(m.signals).toContain('координаты ВНЕ Камчатского края');
  });

  it('но сигнал от этого НЕ понижается', () => {
    // Координаты за краем — всё равно координаты. Понизить их значило бы
    // отказать человеку в помощи за то, что он не там, где мы его ждали.
    const m = classifySosOrigin({ ...EMPTY, lat: 55.75, lng: 37.61 });
    expect(m.klass).toBe('has_content');
    expect(needsEscalation(m.klass)).toBe(true);
  });

  it('координаты в крае лишнего признака не добавляют', () => {
    const m = classifySosOrigin({ ...EMPTY, lat: 53.25, lng: 158.65 });
    expect(m.signals).not.toContain('координаты ВНЕ Камчатского края');
  });

  it('нет координат — не «снаружи», а «не знаю»', () => {
    // Подмена «нет данных» на «за краем» стоила бы человека без спутников.
    const m = classifySosOrigin({ ...EMPTY, secFetchSite: 'same-origin' });
    expect(m.signals).not.toContain('координаты ВНЕ Камчатского края');
  });

  it('по IP география не судится вовсе', () => {
    // Роуминг, спутниковый терминал и VPN дают чужой адрес при человеке в
    // кальдере. Гео-базы нет, и догадки в коде быть не должно.
    const SRC = strip(read('lib/safety/sos-origin.ts'));
    expect(SRC).not.toMatch(/\bip\b/i);
    expect(Object.keys(EMPTY)).not.toContain('ip');
  });
});

describe('эскалация', () => {
  it('112 не зовут только там, где звать не о ком', () => {
    expect(needsEscalation('authenticated')).toBe(true);
    expect(needsEscalation('from_app')).toBe(true);
    expect(needsEscalation('has_content')).toBe(true);
    expect(needsEscalation('unattributed')).toBe(false);
  });

  it('класс не посчитан — эскалация остаётся: чего не измерили, то не смягчаем', () => {
    // Строки до миграции 928 несут origin_class = NULL.
    expect(needsEscalation(null)).toBe(true);
  });
});

describe('приёмник ничего не отклоняет', () => {
  const ROUTE = strip(read('app/api/safety/sos/route.ts'));

  it('пустое тело по-прежнему допустимо', () => {
    expect(ROUTE).toMatch(/rawBody = \{\}/);
  });

  it('класс источника не влияет ни на код ответа, ни на запись', () => {
    // Если бы класс где-то решал «принимать ли», человек без GPS перестал
    // бы доходить. Он влияет ровно на одно — на слова в тревоге.
    const after = ROUTE.slice(ROUTE.indexOf('const origin = classifySosOrigin'));
    expect(after).not.toMatch(/if \(origin\.klass/);
    expect(after).not.toMatch(/origin\.klass ===[^\n]*return/);
  });

  it('класс уходит и в базу, и в текст тревоги', () => {
    expect(ROUTE).toMatch(/origin_class/);
    expect(ROUTE).toMatch(/origin\.klass\]/);
    expect(ROUTE).toMatch(/\$\{origin\.words\}/);
  });
});

describe('«никто не пришёл» не называется «разрешено»', () => {
  const BRIDGE = strip(read('app/api/cron/sos-events-bridge/route.ts'));

  it('исход записывается отдельно от статуса', () => {
    expect(BRIDGE).toMatch(/outcome = 'unknown_no_response'/);
    expect(BRIDGE).toMatch(/outcome_at = NOW\(\)/);
  });

  it('примечание говорит правду, а не «авто-закрыт»', () => {
    expect(BRIDGE).toMatch(/исход НЕИЗВЕСТЕН/);
    expect(BRIDGE).not.toMatch(/Авто-закрыт: нет ответа 24ч/);
  });
});

describe('Watchdog различает, о ком речь', () => {
  const WD = strip(read('lib/agents/watchdog.ts'));

  it('сигналы с неустановленным источником считаются отдельно', () => {
    expect(WD).toMatch(/needsEscalation\(r\.origin_class/);
    expect(WD).toMatch(/type: 'sos_unattributed'/);
  });

  it('они не исчезают: у них своя строка, а не молчание', () => {
    const at = WD.indexOf("type: 'sos_unattributed'");
    expect(at).toBeGreaterThan(0);
    expect(WD.slice(at, at + 500)).toMatch(/молча не закрывать/);
  });

  it('брошенные сигналы объявляются событием', () => {
    expect(WD).toMatch(/type: 'sos_abandoned'/);
    expect(WD).toMatch(/outcome_at > NOW\(\) - INTERVAL '60 minutes'/);
  });

  it('обе проверки зарегистрированы — иначе они мёртвый код', () => {
    expect(WD).toMatch(/checkIgnoredSOS,\s*\n\s*checkAbandonedSOS,/);
  });

  it('отказ обеих проверок логируется, а не выдаётся за «нарушений нет»', () => {
    expect(WD).toMatch(/\[watchdog\] checkIgnoredSOS failed:/);
    expect(WD).toMatch(/\[watchdog\] checkAbandonedSOS failed:/);
  });
});

describe('миграция 928', () => {
  const SQL = read('migrations/928_sos_origin_and_outcome.sql');

  it('идемпотентна', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS origin_class/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS outcome/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS outcome_at/);
  });

  it('статус не трогается: CHECK у sos_events нам неизвестен', () => {
    // Таблицы нет ни в одной миграции (см. schema-coverage), поэтому
    // менять допустимые значения status вслепую нельзя.
    expect(SQL).not.toMatch(/DROP CONSTRAINT/);
    expect(SQL).not.toMatch(/ALTER COLUMN status/);
  });
});
