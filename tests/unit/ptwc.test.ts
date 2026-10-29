// @vitest-environment node
/**
 * Разбор бюллетеней PTWC (lib/services/safety/ptwc) — вызовом на настоящих
 * образцах: индекс слота с прода (проба 1009, Вануату 24.10.2026) и сообщения
 * №1 и №2 о землетрясении M8.7 у Камчатки 29.07.2025 (пробы 1011–1012).
 *
 * Правило §4.0: относится ли угроза к краю, решают координаты точек в таблице
 * прихода волны, а не слово «RUSSIA» (Уруп и Гастелло — Россия, но не край);
 * старый бюллетень — прошлое, а не обстановка; непрочитанный — «не смог», а
 * не «угрозы нет».
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parsePtwcIndex, parsePtwcMessage, ptwcVerdict, ptwcTime, loadPtwcLatest, etaLineRu, splitNameRegion, PTWC_INDEX_URL,
} from '@/lib/services/safety/ptwc';

/** Индекс слота как отдаёт tsunami.gov — с невалидной точкой «28.,» (так бывает у целых координат). */
const INDEX_JSON = `{
"eventDir" : "/events/PHEB/2025/07/29/25210000/2/WEPA40/",
"thisDocGenerated" : "Wed Jul 30 00:16:30 UTC 2025",
"TWCID" : "PHEB",
"WMOID" : "WEPA40",
"eventMagnitude" : 8.7,
"eventMagnitudeType" : "Mwp",
"eventDepth" : 74,
"eventLat" : 52.2,
"eventLon" : 160.,
"originTime" : "2025-07-29T23:25:00Z",
"bulletinIssueTime" : "2025-07-30T00:16:00Z",
"quakeLocation" : "OFF THE EAST COAST OF KAMCHATKA RUSSIA",
"twcEventID" : "25210000",
"bulletinNr" : "2",
"alerts" : {"areaList":[[]]}
}`;

const MESSAGE_1 = `TSUNAMI MESSAGE NUMBER 1
NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI
2334 UTC TUE JUL 29 2025
...PTWC TSUNAMI THREAT MESSAGE...
**** NOTICE **** NOTICE **** NOTICE **** NOTICE **** NOTICE *****
 THIS MESSAGE IS ISSUED FOR INFORMATION ONLY IN SUPPORT OF THE
 UNESCO/IOC PACIFIC TSUNAMI WARNING AND MITIGATION SYSTEM AND IS
 MEANT FOR NATIONAL AUTHORITIES IN EACH COUNTRY OF THAT SYSTEM.
**** NOTICE **** NOTICE **** NOTICE **** NOTICE **** NOTICE *****
PRELIMINARY EARTHQUAKE PARAMETERS
---------------------------------
 * MAGNITUDE 8.0
 * ORIGIN TIME 2325 UTC JUL 29 2025
 * COORDINATES 52.2 NORTH 160.0 EAST
 * DEPTH 74 KM / 46 MILES
 * LOCATION OFF THE EAST COAST OF KAMCHATKA RUSSIA
EVALUATION
----------
 * AN EARTHQUAKE WITH A PRELIMINARY MAGNITUDE OF 8.0 OCCURRED
 OFF THE EAST COAST OF KAMCHATKA, RUSSIA AT 2325 UTC ON
 TUESDAY JULY 29 2025.
 * BASED ON THE PRELIMINARY EARTHQUAKE PARAMETERS... WIDESPREAD
 HAZARDOUS TSUNAMI WAVES ARE POSSIBLE.
TSUNAMI THREAT FORECAST
-----------------------
 * HAZARDOUS TSUNAMI WAVES FROM THIS EARTHQUAKE ARE POSSIBLE
 WITHIN THE NEXT THREE HOURS ALONG SOME COASTS OF
 RUSSIA AND JAPAN
RECOMMENDED ACTIONS
-------------------
 * GOVERNMENT AGENCIES RESPONSIBLE FOR THREATENED COASTAL AREAS
 SHOULD TAKE ACTION TO INFORM AND INSTRUCT ANY COASTAL
 POPULATIONS AT RISK IN ACCORDANCE WITH THEIR OWN
 EVALUATION... PROCEDURES AND THE LEVEL OF THREAT.
ESTIMATED TIMES OF ARRIVAL
--------------------------
 * ESTIMATED TIMES OF ARRIVAL -ETA- OF THE INITIAL TSUNAMI WAVE
 FOR PLACES WITH A POTENTIAL TSUNAMI THREAT. ACTUAL ARRIVAL
 TIMES MAY DIFFER AND THE INITIAL WAVE MAY NOT BE THE
 LARGEST.
 LOCATION REGION COORDINATES ETA(UTC)
 ------------------------------------------------------------
 PETROPAVLOVSK RUSSIA 53.2N 159.6E 2358 07/29
 UST KAMCHATSK RUSSIA 56.1N 162.6E 0012 07/30
 MEDNNY ISLAND RUSSIA 54.7N 167.4E 0035 07/30
 OSTROV KARAGINS RUSSIA 58.8N 164.5E 0040 07/30
 URUP ISLAND RUSSIA 46.1N 150.5E 0047 07/30
 SEVERO KURILSK RUSSIA 50.8N 156.1E 0110 07/30
 KUSHIRO JAPAN 42.9N 144.3E 0132 07/30
 HACHINOHE JAPAN 40.5N 141.5E 0212 07/30
POTENTIAL IMPACTS
-----------------
 * A TSUNAMI IS A SERIES OF WAVES.
NEXT UPDATE AND ADDITIONAL INFORMATION
--------------------------------------
 * THE NEXT MESSAGE WILL BE ISSUED IN ONE HOUR... OR SOONER IF
 THE SITUATION WARRANTS.
$$
TSUNAMI MESSAGE NUMBER 2
NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI
0016 UTC WED JUL 30 2025
...PTWC TSUNAMI THREAT MESSAGE...
`;

const MESSAGE_2 = `TSUNAMI MESSAGE NUMBER 2
NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI
0016 UTC WED JUL 30 2025
...PTWC TSUNAMI THREAT MESSAGE...
THE TSUNAMI FORECAST IS UPDATED IN THIS MESSAGE.
PRELIMINARY EARTHQUAKE PARAMETERS
---------------------------------
 * MAGNITUDE 8.7
 * ORIGIN TIME 2325 UTC JUL 29 2025
 * COORDINATES 52.2 NORTH 160.0 EAST
 * DEPTH 74 KM / 46 MILES
 * LOCATION OFF THE EAST COAST OF KAMCHATKA RUSSIA
EVALUATION
----------
 * BASED ON ALL AVAILABLE DATA... HAZARDOUS TSUNAMI WAVES ARE
 FORECAST FOR SOME COASTS.
TSUNAMI THREAT FORECAST...UPDATED
---------------------------------
 * TSUNAMI WAVES REACHING MORE THAN 3 METERS ABOVE THE TIDE
 LEVEL ARE POSSIBLE ALONG SOME COASTS OF
 NORTHWESTERN HAWAIIAN ISLANDS... AND RUSSIA.
 * TSUNAMI WAVES REACHING 1 TO 3 METERS ABOVE THE TIDE LEVEL ARE
 POSSIBLE ALONG SOME COASTS OF
 GUAM... HAWAII... JAPAN... JOHNSTON ATOLL... MIDWAY
 ISLAND... NORTHERN MARIANAS... AND PALMYRA ISLAND.
 * TSUNAMI WAVES REACHING 0.3 TO 1 METERS ABOVE THE TIDE LEVEL
 ARE POSSIBLE FOR SOME COASTS OF
 CHUUK... KOSRAE... MARSHALL ISLANDS... PALAU...
 PHILIPPINES... POHNPEI... WAKE ISLAND... AND YAP.
 * TSUNAMI WAVES ARE FORECAST TO BE LESS THAN 0.3 METERS ABOVE
 THE TIDE LEVEL FOR THE COASTS OF
 DPR OF KOREA... REPUBLIC OF KOREA... AND TAIWAN.
 * ACTUAL AMPLITUDES AT THE COAST MAY VARY FROM FORECAST
 AMPLITUDES DUE TO UNCERTAINTIES IN THE FORECAST AND LOCAL
 FEATURES.
RECOMMENDED ACTIONS
-------------------
 * GOVERNMENT AGENCIES RESPONSIBLE FOR THREATENED COASTAL AREAS
 SHOULD TAKE ACTION TO INFORM AND INSTRUCT ANY COASTAL
 POPULATIONS AT RISK.
ESTIMATED TIMES OF ARRIVAL
--------------------------
 LOCATION REGION COORDINATES ETA(UTC)
 ------------------------------------------------------------
 PETROPAVLOVSK RUSSIA 53.2N 159.6E 2358 07/29
 UST KAMCHATSK RUSSIA 56.1N 162.6E 0012 07/30
 URUP ISLAND RUSSIA 46.1N 150.5E 0047 07/30
 SEVERO KURILSK RUSSIA 50.8N 156.1E 0110 07/30
 MIDWAY ISLAND MIDWAY ISLAND 28.2N 177.4W 0327 07/30
 GASTELLO RUSSIA 49.1N 143.0E 0339 07/30
 HOWLAND ISLAND HOWLAND AND BAKE 0.6N 176.6W 0654 07/30
 NAURU NAURU 0.5S 166.9E 0640 07/30
POTENTIAL IMPACTS
-----------------
 * A TSUNAMI IS A SERIES OF WAVES.
$$
`;

/** Бюллетень дальнего события: Россия не названа, точек края в таблице нет. */
const MESSAGE_FAR = `TSUNAMI MESSAGE NUMBER 1
NWS PACIFIC TSUNAMI WARNING CENTER HONOLULU HI
0330 UTC SAT OCT 24 2026
...PTWC TSUNAMI THREAT MESSAGE...
PRELIMINARY EARTHQUAKE PARAMETERS
---------------------------------
 * MAGNITUDE 7.4
 * ORIGIN TIME 0231 UTC OCT 24 2026
 * COORDINATES 13.8 SOUTH 165.7 EAST
 * LOCATION VANUATU
TSUNAMI THREAT FORECAST
-----------------------
 * HAZARDOUS TSUNAMI WAVES FROM THIS EARTHQUAKE ARE POSSIBLE
 WITHIN THE NEXT THREE HOURS ALONG SOME COASTS OF
 VANUATU AND NEW CALEDONIA
RECOMMENDED ACTIONS
-------------------
ESTIMATED TIMES OF ARRIVAL
--------------------------
 LOCATION REGION COORDINATES ETA(UTC)
 ------------------------------------------------------------
 ESPERITU SANTO VANUATU 15.1S 167.3E 0245 10/24
 NOUMEA NEW CALEDONIA 22.3S 166.5E 0331 10/24
$$
`;

const MESSAGE_PASSED = MESSAGE_2
  .replace('THE TSUNAMI FORECAST IS UPDATED IN THIS MESSAGE.', 'THE TSUNAMI THREAT HAS NOW LARGELY PASSED.')
  .replace('TSUNAMI MESSAGE NUMBER 2', 'TSUNAMI MESSAGE NUMBER 9');

describe('индекс слота', () => {
  it('невалидная точка «160.,» чинится, поля прочитаны, адрес сообщения из eventDir', () => {
    const idx = parsePtwcIndex(INDEX_JSON)!;
    expect(idx).toMatchObject({
      twcEventId: '25210000', bulletinNr: 2, issuedAt: '2025-07-30T00:16:00.000Z',
      originTime: '2025-07-29T23:25:00.000Z', magnitude: 8.7, lat: 52.2, lon: 160,
      location: 'OFF THE EAST COAST OF KAMCHATKA RUSSIA',
      messageUrl: 'https://www.tsunami.gov/events/PHEB/2025/07/29/25210000/2/WEPA40/WEPA40.txt',
    });
  });
  it('не индекс — null, а не пустой бюллетень', () => {
    expect(parsePtwcIndex('<html>503</html>')).toBeNull();
    expect(parsePtwcIndex('{"TWCID":"PHEB"}')).toBeNull();
    expect(parsePtwcIndex(INDEX_JSON.replace('"bulletinIssueTime" : "2025-07-30T00:16:00Z",', ''))).toBeNull();
  });
});

describe('время PTWC', () => {
  it('с днём недели и без, несуществующее — null', () => {
    expect(ptwcTime('0016 UTC WED JUL 30 2025')).toBe('2025-07-30T00:16:00.000Z');
    expect(ptwcTime('2325 UTC JUL 29 2025')).toBe('2025-07-29T23:25:00.000Z');
    expect(ptwcTime('2560 UTC JUL 29 2025')).toBeNull();
    expect(ptwcTime('0010 UTC FEB 30 2025')).toBeNull();
  });
});

describe('сообщение об угрозе', () => {
  it('№1: угроза, предварительно «Россия и Япония», точки края по координатам, Уруп не край', () => {
    const m = parsePtwcMessage(MESSAGE_1);
    expect(m).toMatchObject({
      kind: 'threat', messageNumber: 1, issuedAt: '2025-07-29T23:34:00.000Z', magnitude: 8,
      originTime: '2025-07-29T23:25:00.000Z', location: 'OFF THE EAST COAST OF KAMCHATKA RUSSIA',
      threatPassed: false, russiaBand: null, russiaPreliminary: true,
    });
    expect(m.etas).toHaveLength(8);
    expect(m.kraiPoints.map((p) => p.name)).toEqual([
      'PETROPAVLOVSK', 'UST KAMCHATSK', 'MEDNNY ISLAND', 'OSTROV KARAGINS', 'SEVERO KURILSK',
    ]);
    // Год у ETA берётся от выпуска; ночь на 30.07 — следующие сутки.
    expect(m.kraiPoints[0].etaAt).toBe('2025-07-29T23:58:00.000Z');
    expect(m.kraiPoints[1].etaAt).toBe('2025-07-30T00:12:00.000Z');
    // В файле два сообщения подряд — разобрано первое, второе в него не течёт.
    expect(m.messageNumber).toBe(1);
  });

  it('№2: полоса высот для России — более 3 м, Гастелло (Сахалин) не край, запад и юг не мешают', () => {
    const m = parsePtwcMessage(MESSAGE_2);
    expect(m.kind).toBe('threat');
    expect(m.russiaBand).toBe('gt3');
    expect(m.russiaPreliminary).toBe(false);
    expect(m.etas).toHaveLength(8);
    expect(m.etas.find((e) => e.name === 'MIDWAY ISLAND')).toMatchObject({ lat: 28.2, lon: -177.4 });
    expect(m.etas.find((e) => e.name === 'NAURU')).toMatchObject({ lat: -0.5, lon: 166.9 });
    expect(m.kraiPoints.map((p) => p.name)).toEqual(['PETROPAVLOVSK', 'UST KAMCHATSK', 'SEVERO KURILSK']);
    expect(m.etas.find((e) => e.name === 'HOWLAND ISLAND')?.region).toBe('HOWLAND AND BAKE');
  });

  it('колонки фиксированной ширины (как в .txt) делятся по двум пробелам', () => {
    expect(splitNameRegion('UST KAMCHATSK    RUSSIA          ')).toEqual(['UST KAMCHATSK', 'RUSSIA']);
    expect(splitNameRegion('UST KAMCHATSK RUSSIA')).toEqual(['UST KAMCHATSK', 'RUSSIA']);
    expect(splitNameRegion('GISBORNE NEW ZEALAND')).toEqual(['GISBORNE', 'NEW ZEALAND']);
    expect(splitNameRegion('NAURU')).toEqual(['NAURU', '']);
  });

  it('дальнее событие: Россия не названа, точек края нет — края не касается', () => {
    const m = parsePtwcMessage(MESSAGE_FAR);
    expect(m.kind).toBe('threat');
    expect(m.russiaBand).toBeNull();
    expect(m.russiaPreliminary).toBe(false);
    expect(m.etas).toHaveLength(2);
    expect(m.kraiPoints).toEqual([]);
  });

  it('«угроза в основном миновала» — снята самим центром; «последнее сообщение» само по себе — нет', () => {
    expect(parsePtwcMessage(MESSAGE_PASSED).threatPassed).toBe(true);
    expect(parsePtwcMessage(MESSAGE_2).threatPassed).toBe(false);
    const finalWithEtas = MESSAGE_2.replace('THE TSUNAMI FORECAST IS UPDATED IN THIS MESSAGE.', 'THIS WILL BE THE FINAL MESSAGE FOR THIS EVENT UNLESS NEW INFORMATION BECOMES AVAILABLE.');
    expect(parsePtwcMessage(finalWithEtas).threatPassed).toBe(false);
  });

  it('шапка без времени — строки ETA остаются, датируются временем выпуска из индекса', () => {
    const noHeader = MESSAGE_2.replace('0016 UTC WED JUL 30 2025', 'XXXX');
    const bare = parsePtwcMessage(noHeader);
    expect(bare.issuedAt).toBeNull();
    expect(bare.kraiPoints.map((p) => p.name)).toEqual(['PETROPAVLOVSK', 'UST KAMCHATSK', 'SEVERO KURILSK']);
    expect(bare.kraiPoints[0].etaAt).toBeNull();
    const dated = parsePtwcMessage(noHeader, '2025-07-30T00:16:00.000Z');
    expect(dated.kraiPoints[0].etaAt).toBe('2025-07-29T23:58:00.000Z');
  });

  it('не сообщение — ничего не выдумано', () => {
    const m = parsePtwcMessage('404 Not Found');
    expect(m).toMatchObject({ kind: 'unknown', messageNumber: null, issuedAt: null, magnitude: null, russiaBand: null });
    expect(m.etas).toEqual([]);
  });
});

describe('вердикт для края', () => {
  const idx = parsePtwcIndex(INDEX_JSON)!;
  const fresh = new Date('2025-07-30T01:00:00Z');

  it('свежий бюллетень с точками края — угроза краю', () => {
    expect(ptwcVerdict(idx, parsePtwcMessage(MESSAGE_2), fresh)).toBe('threat_to_krai');
    expect(ptwcVerdict(idx, parsePtwcMessage(MESSAGE_1), fresh)).toBe('threat_to_krai');
  });
  it('снята центром — passed; дальнее событие — края не касается', () => {
    expect(ptwcVerdict(idx, parsePtwcMessage(MESSAGE_PASSED), fresh)).toBe('passed');
    expect(ptwcVerdict(idx, parsePtwcMessage(MESSAGE_FAR), fresh)).toBe('no_krai_threat');
  });
  it('бюллетень старше суток — прошлое, не обстановка, даже с точками края', () => {
    expect(ptwcVerdict(idx, parsePtwcMessage(MESSAGE_2), new Date('2025-07-31T01:00:00Z'))).toBe('stale');
    expect(ptwcVerdict(idx, null, new Date('2026-10-29T00:00:00Z'))).toBe('stale');
  });
  it('без сообщения свежий бюллетень угрозой не считается', () => {
    expect(ptwcVerdict(idx, null, fresh)).toBe('no_krai_threat');
  });
});

describe('загрузка', () => {
  const fresh = new Date('2025-07-30T01:00:00Z');

  it('индекс, затем сообщение по адресу из индекса; своим агентом', async () => {
    const f = vi.fn(async (url: string) => new Response(url === PTWC_INDEX_URL ? INDEX_JSON : MESSAGE_2, { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const read = await loadPtwcLatest(f, fresh);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.verdict).toBe('threat_to_krai');
    expect(read.message?.kraiPoints).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0]).toBe('https://www.tsunami.gov/events/PHEB/2025/07/29/25210000/2/WEPA40/WEPA40.txt');
    expect(((f.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['user-agent']).toMatch(/^VedarBot/);
  });

  it('старый бюллетень — второго похода нет', async () => {
    const f = vi.fn(async () => new Response(INDEX_JSON, { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const read = await loadPtwcLatest(f, new Date('2026-10-29T00:00:00Z'));
    expect(read).toMatchObject({ kind: 'ok', verdict: 'stale', message: null });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('индекс не отдан или сообщение не отдано — failed с причиной, не «угрозы нет»', async () => {
    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await loadPtwcLatest(down, fresh)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('HTTP 503'), index: null });

    const half = vi.fn(async (url: string) => new Response(url === PTWC_INDEX_URL ? INDEX_JSON : '', { status: url === PTWC_INDEX_URL ? 200 : 403 })) as unknown as typeof fetch;
    const read = await loadPtwcLatest(half, fresh);
    expect(read.kind).toBe('failed');
    if (read.kind === 'failed') {
      expect(read.reason).toMatch(/HTTP 403/);
      expect(read.index?.twcEventId).toBe('25210000');
    }

    const net = vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    expect(await loadPtwcLatest(net, fresh)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('fetch failed') });
  });

  it('200 с заглушкой вместо бюллетеня — failed, а не «угрозы нет»', async () => {
    const wall = vi.fn(async (url: string) => new Response(url === PTWC_INDEX_URL ? INDEX_JSON : '<html>Access denied</html>', { status: 200 })) as unknown as typeof fetch;
    const read = await loadPtwcLatest(wall, fresh);
    expect(read.kind).toBe('failed');
    if (read.kind === 'failed') expect(read.reason).toMatch(/не разобран/);
  });
});

describe('строка прихода для дежурного', () => {
  it('UTC и время по Камчатке (UTC+12), у каждого своя дата, имя по-русски', () => {
    const m = parsePtwcMessage(MESSAGE_2);
    expect(etaLineRu(m.kraiPoints[0])).toBe('Петропавловск-Камчатский 23:58 UTC 29.07 (11:58 по Камчатке 30.07)');
    expect(etaLineRu({ name: 'OLYUTORSKY', region: 'RUSSIA', lat: 60.4, lon: 168.2, etaAt: '2025-07-30T00:40:00.000Z' }))
      .toBe('OLYUTORSKY 00:40 UTC 30.07 (12:40 по Камчатке 30.07)');
    expect(etaLineRu({ name: 'PETROPAVLOVSK', region: 'RUSSIA', lat: 53.2, lon: 159.6, etaAt: null }))
      .toBe('Петропавловск-Камчатский (время прихода не разобрано)');
  });
});
