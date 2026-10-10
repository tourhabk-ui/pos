/**
 * Сторож основания дорожных закрытий (10.10).
 *
 * Повод — разговор владельца: в ленте «Безопасность» было закрытие дороги на
 * Усть-Большерецк (Октябрьская коса), а приказа КГКУ «Камчатуправтодор», по
 * которому её закрыли, не было — он лежал снимком в канале «Право на Руль»,
 * которого не было среди наших источников. Держится связка целиком:
 *  - канал читается раннером и разбирается по блоку поста (снимок, ссылка,
 *    время), в ленту идут только ограничения проезда — не ДТП, не улицы
 *    города, не открытие;
 *  - срок пункта — тот, что назван в посте, по времени Камчатки, округлён
 *    вверх; не назван — сутки, и экран пишет «сообщение от»;
 *  - основание со снимка: зрение отвечает JSON, документ собирается
 *    словами, «не смогли» отличается от «не документ»; фамилий модель не
 *    выписывает;
 *  - срок распознанным приказом только продлевается, ручное основание
 *    автомат не трогает;
 *  - основание видно на главной, на /safety, в сводке и агенту — с пометкой,
 *    что прочитано со снимка;
 *  - раннер приносит снимок только по запросу сервера и только с CDN Telegram.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));

const channel = await import('@/lib/services/safety/road-channel');
const basis = await import('@/lib/safety/road-basis');
const queue = await import('@/lib/safety/road-basis-queue');
const { basisOf, basisLine } = await import('@/lib/safety/alert-basis');
const { alertStamp } = await import('@/components/safety/LiveStatus');
const { alertOrigin } = await import('@/lib/safety/alert-origin');

const read = (p: string) => readFileSync(p, 'utf8');

/** Разметка t.me/s/pravonarul по пробе 753 (10.10): блок поста, снимок, текст, время. */
function post(id: number, opts: { text?: string; photo?: string; video?: boolean; datetime: string }) {
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="pravonarul/${id}" data-view="x">
<div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/pravonarul"><span dir="auto">Право на Руль</span></a></div>
${opts.photo ? `<a class="tgme_widget_message_photo_wrap blured 5348 1245_460" href="https://t.me/pravonarul/${id}" style="width:598px;background-image:url('${opts.photo}')"><div class="tgme_widget_message_photo" style="width:99.6%"></div></a>` : ''}
${opts.video ? `<a class="tgme_widget_message_video_player blured js-message_video_player" href="https://t.me/pravonarul/${id}"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/thumb.jpg')"></i></a>` : ''}
${opts.text !== undefined ? `<div class="tgme_widget_message_text js-message_text" dir="auto">${opts.text}</div>` : ''}
<div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info"><span class="tgme_widget_message_views">2.03K</span><span class="copyonly"></span><a class="tgme_widget_message_date" href="https://t.me/pravonarul/${id}"><time datetime="${opts.datetime}" class="time">18:05</time></a></div></div>
</div></div>`;
}

const PHOTO = 'https://cdn4.telesco.pe/file/v0tAbC_d-123.jpg';
// 18:05 по Камчатке 08.10 = 06:05 UTC.
const CLOSED_AT = '2026-10-08T06:05:00+00:00';
const EXTENDED_AT = '2026-10-09T05:30:00+00:00';
const PAGE = [
  post(18785, {
    text: 'Октябрьскую косу закрыли для проезда — пока до 10 утра,<br/>\n сообщили в Камчатском управлении автодорог<br/>\n<br/>\n<a href="https://t.me/pravonarul" target="_blank">@pravonarul</a>',
    photo: PHOTO,
    datetime: CLOSED_AT,
  }),
  post(18786, { photo: 'https://cdn4.telesco.pe/file/only-photo.jpg', datetime: '2026-10-08T07:00:00+00:00' }),
  post(18787, { text: 'На трассе у Елизово ДТП, движение перекрыто, пострадал водитель', datetime: '2026-10-08T08:00:00+00:00' }),
  post(18788, { text: 'Перекрыт проезд по улице Ленинской на время ремонта до 18:00', datetime: '2026-10-08T09:00:00+00:00' }),
  post(18789, {
    text: 'Закрытие Октябрьской  косы продлили ещё на сутки — до десяти утра завтрашнего дня,<br/>\n сообщили в Камчатском управлении автодорог.',
    video: true,
    datetime: EXTENDED_AT,
  }),
  post(18790, { text: 'Октябрьскую косу открыли для проезда после шторма', datetime: '2026-10-10T00:00:00+00:00' }),
  post(18791, { text: 'Водителей просят быть внимательнее: на дорогах гололёд', photo: 'https://evil.example/x.jpg', datetime: '2026-10-10T01:00:00+00:00' }),
].join('\n');

describe('канал «Право на Руль»: посты по блоку, снимки только с CDN Telegram', () => {
  const posts = channel.parseChannelPosts(PAGE);

  it('каждый пост — свой id, ссылка, время и снимки; пост без текста не съедает чужой текст', () => {
    expect(posts.map((p) => p.id)).toEqual([18785, 18786, 18787, 18788, 18789, 18790, 18791].map((n) => `t.me/pravonarul/${n}`));
    const first = posts[0];
    expect(first.url).toBe('https://t.me/pravonarul/18785');
    expect(first.datetime).toBe(CLOSED_AT);
    expect(first.photos).toEqual([PHOTO]);
    expect(first.text).toMatch(/^Октябрьскую косу закрыли для проезда — пока до 10 утра,\n\s*сообщили/);
    // Пост с одним фото — без текста, и текст соседа ему не приписан.
    expect(posts[1].text).toBe('');
    expect(posts[4].text).toMatch(/^Закрытие Октябрьской/);
    // Видео — не снимок; чужой хост — не снимок.
    expect(posts[4].photos).toEqual([]);
    expect(posts[6].photos).toEqual([]);
  });

  it('в ленту — только ограничение проезда: не ДТП, не улица города, не открытие, не пустой пост', () => {
    const events = posts.map((p) => channel.classifyRoadChannelPost(p));
    expect(events.map((e) => e?.source_id ?? null)).toEqual([
      't.me/pravonarul/18785', null, null, null, 't.me/pravonarul/18789', null, null,
    ]);
    const closed = events[0]!;
    expect(closed).toMatchObject({
      alert_type: 'road_closure',
      severity: 2,
      source_url: 'https://t.me/pravonarul/18785',
      title: 'Октябрьскую косу закрыли для проезда — пока до 10 утра',
      affected_zones: ['western'],
    });
    // Подпись канала в описание не попадает.
    expect(closed.description).not.toMatch(/@pravonarul/);
  });

  it('срок — названный постом, по Камчатке, вверх: «до 10 утра» в 18:05 — до 10:00 следующего дня', () => {
    const closed = channel.classifyRoadChannelPost(posts[0])!;
    const until = new Date(new Date(CLOSED_AT).getTime() + closed.expires_hours * 3_600_000);
    expect(until.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-08T22:00:00Z'));
    expect(until.getTime() - Date.parse('2026-10-08T22:00:00Z')).toBeLessThan(3_600_000);
    // «до десяти утра завтрашнего дня» в 17:30 09.10 — 10:00 10.10 по Камчатке.
    expect(channel.closureUntil(posts[4].text, new Date(EXTENDED_AT))?.toISOString()).toBe('2026-10-09T22:00:00.000Z');
  });

  it('разбор срока: часы цифрами и словами, вечер, «на сутки»; ничего не названо — null', () => {
    const at = new Date('2026-10-08T06:05:00Z'); // 18:05 Камчатки
    expect(channel.closureUntil('ограничено до 20:00', at)?.toISOString()).toBe('2026-10-08T08:00:00.000Z');
    expect(channel.closureUntil('закрыто до 8 вечера', at)?.toISOString()).toBe('2026-10-08T08:00:00.000Z');
    expect(channel.closureUntil('закрыто до восьми утра', at)?.toISOString()).toBe('2026-10-08T20:00:00.000Z');
    expect(channel.closureUntil('проезд закрыт на сутки', at)?.toISOString()).toBe('2026-10-09T06:05:00.000Z');
    expect(channel.closureUntil('проезд закрыт до 15 километра', at)).toBeNull();
    expect(channel.closureUntil('проезд закрыт', at)).toBeNull();
    // Без срока — сутки, тот технический срок, который экран узнаёт и пишет «сообщение от».
    const noTerm = channel.classifyRoadChannelPost({ id: 't.me/pravonarul/1', url: 'https://t.me/pravonarul/1', text: 'Закрыт проезд к Мутновскому из-за снега', datetime: CLOSED_AT, photos: [] });
    expect(noTerm?.expires_hours).toBe(channel.DEFAULT_ROAD_HOURS);
  });

  it('Октябрьская коса — западная зона и в общей карте зон', async () => {
    const { mchs_zones } = await import('@/lib/services/safety/seismic-parser');
    expect(mchs_zones('Закрытие Октябрьской косы продлили')).toEqual(['western']);
  });

  it('подпись источника — канал, а не ведомство', () => {
    expect(alertOrigin('t.me/pravonarul/18785', 'https://t.me/pravonarul/18785')).toEqual({
      key: 'pravonarul', label: 'Telegram-канал «Право на Руль» (дороги)',
    });
  });
});

describe('основание со снимка', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const answer = (o: Record<string, unknown>) => async () => ({ text: `Вот ответ:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``, legs: [] });
  const ORDER = {
    is_document: true, kind: 'ПРИКАЗ', issuer: 'КГКУ «Камчатуправтодор»', date: '08.10.2026', number: '122',
    title: 'Об ограничении движения транспортных средств', closed_until: '09.10.2026 10:00',
    road: 'Начикинский совхоз – Усть-Большерецк – п. Октябрьский, км 109–128',
  };

  it('документ собирается словами: вид, издатель, дата, номер, название; срок — по Камчатке', async () => {
    const r = await basis.readBasisFromImage('AAAA', 'image/jpeg', answer(ORDER) as never);
    expect(r).toEqual({
      outcome: 'found',
      title: 'Приказ КГКУ «Камчатуправтодор» от 08.10.2026 № 122 «Об ограничении движения транспортных средств»',
      validUntil: new Date('2026-10-08T22:00:00Z'),
    });
  });

  it('не документ, не JSON, без издателя — no_document; зрение молчит или падает — unavailable', async () => {
    expect((await basis.readBasisFromImage('A', 'image/jpeg', answer({ ...ORDER, is_document: false }) as never)).outcome).toBe('no_document');
    expect((await basis.readBasisFromImage('A', 'image/jpeg', (async () => ({ text: 'на фото дорога', legs: [] })) as never)).outcome).toBe('no_document');
    expect((await basis.readBasisFromImage('A', 'image/jpeg', answer({ ...ORDER, issuer: null }) as never)).outcome).toBe('no_document');
    const silent = await basis.readBasisFromImage('A', 'image/jpeg', (async () => ({ text: null, legs: [{ provider: 'qwen_vl', model: 'x', outcome: 'http_error', detail: '503', ms: 1 }] })) as never);
    expect(silent).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('qwen_vl') });
    const thrown = await basis.readBasisFromImage('A', 'image/jpeg', (async () => { throw new Error('сеть'); }) as never);
    expect(thrown.outcome).toBe('unavailable');
  });

  it('неправдоподобный срок не продлевает: основание есть, validUntil — null', async () => {
    const r = await basis.readBasisFromImage('A', 'image/jpeg', answer({ ...ORDER, closed_until: '09.10.2062 10:00' }) as never);
    expect(r).toMatchObject({ outcome: 'found', validUntil: null });
    expect(basis.parseKamchatkaDateTime('31.02.2026 10:00')).toBeNull();
    // Без часа — конец дня: поздний край безопаснее раннего.
    expect(basis.parseKamchatkaDateTime('09.10.2026')?.toISOString()).toBe('2026-10-09T11:59:00.000Z');
  });

  it('модель не просят выписывать людей; промпт не требует того, чего не видно', () => {
    const src = read('lib/safety/road-basis.ts');
    expect(src).toMatch(/Фамилии и имена людей не выписывай/);
    expect(src).toMatch(/Чего не видно или не читается — null\. Не придумывай/);
  });
});

describe('очередь и запись: ручное не трогается, срок — только вверх', () => {
  const q = vi.fn();
  const db = { query: q } as never;
  beforeEach(() => q.mockReset().mockResolvedValue({ rows: [], rowCount: 1 }));

  it('непроверенные — живые, без основания, не смотренные (или зрение молчало час назад)', async () => {
    await queue.pendingBasisChecks(['t.me/pravonarul/18785'], db);
    const sql = String(q.mock.calls[0][0]);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
    expect(sql).toMatch(/basis_title IS NULL/);
    expect(sql).toMatch(/basis_check_outcome IS NULL\s+OR \(basis_check_outcome = 'unavailable' AND basis_checked_at < NOW\(\) - INTERVAL '1 hour'\)/);
    q.mockClear();
    expect(await queue.pendingBasisChecks([], db)).toEqual(new Set());
    expect(q).not.toHaveBeenCalled();
  });

  it('найдено — image_ocr, срок GREATEST, только поверх пустого; иначе — только отметка', async () => {
    await queue.applyBasisReading('t.me/pravonarul/18785', { outcome: 'found', title: 'Приказ X от 08.10.2026 № 1', validUntil: new Date('2026-10-09T22:00:00Z') }, 'https://t.me/pravonarul/18785', db);
    const sql = String(q.mock.calls[0][0]);
    expect(sql).toMatch(/basis_origin = 'image_ocr'/);
    expect(sql).toMatch(/GREATEST\(expires_at, \$4::timestamptz\)/);
    expect(sql).toMatch(/AND basis_title IS NULL/);
    expect(sql).not.toMatch(/'manual'/);
    q.mockClear();
    await queue.applyBasisReading('t.me/pravonarul/18785', { outcome: 'unavailable', reason: 'x' }, 'https://t.me/pravonarul/18785', db);
    expect(String(q.mock.calls[0][0])).not.toMatch(/expires_at|basis_title =/);
    expect(q.mock.calls[0][1]).toEqual(['t.me/pravonarul/18785', 'unavailable']);
  });
});

describe('основание на экране и у агента', () => {
  it('ссылка — только https; пометка «распознано» у прочитанного со снимка', () => {
    expect(basisOf({ basis_title: 'Приказ', basis_url: 'javascript:alert(1)', basis_origin: 'image_ocr' })).toEqual({ title: 'Приказ', url: null, recognized: true });
    expect(basisOf({ basis_title: '  ', basis_url: 'https://x.ru', basis_origin: 'manual' })).toBeNull();
    expect(basisOf({ basis_title: 'Приказ', basis_url: 'http://x.ru/doc', basis_origin: 'manual' })?.url).toBeNull();
    expect(basisOf({ basis_title: 'Приказ', basis_url: 'https://t.me/pravonarul/18785', basis_origin: 'manual' }))
      .toEqual({ title: 'Приказ', url: 'https://t.me/pravonarul/18785', recognized: false });
    expect(basisLine({ title: 'Приказ X', url: 'https://t.me/pravonarul/1', recognized: true }))
      .toBe('основание: Приказ X (распознано со снимка, номер сверять по ссылке: https://t.me/pravonarul/1)');
    expect(basisLine({ title: 'Приказ X', url: null, recognized: false })).toBe('основание: Приказ X (внесено вручную)');
  });

  it('главная и /safety: SELECT несёт основание, бегущая строка показывает его с пометкой', () => {
    const data = read('app/_home/data.ts');
    expect(data.match(/basis_title, basis_url, basis_origin/g)?.length).toBeGreaterThanOrEqual(2);
    expect(data).toMatch(/basis: basisOf\(r\)/);
    const live = read('components/safety/LiveStatus.tsx');
    expect(live).toMatch(/Основание:/);
    expect(live).toMatch(/a\.basis\.recognized \? ' — распознано со снимка' : ''/);
  });

  it('агент и сводка: основание каждого пункта рядом с заголовком, тем же порядком', () => {
    const cs = read('lib/safety/current-status.ts');
    expect(cs).toMatch(/feedBasis = feed\.rows\.slice\(0, AGENT_FEED_TITLES_LIMIT\)\.map\(\(r\) => basisOf\(r\)\)/);
    expect(cs).toMatch(/basisLine\(status\.feedBasis\?\.\[i\] \?\? null\)/);
    expect(read('lib/svodka/svodka.ts')).toMatch(/основание: \$\{basis\.title\}/);
    expect(read('app/svodka/page.tsx')).toMatch(/Основание:/);
  });

  it('короткое ограничение — с часом по Камчатке, длинное — датой', () => {
    expect(alertStamp({ type: 'road_closure', at: '2026-10-08T06:05:00Z', until: '2026-10-08T22:05:00Z' })).toMatch(/действует до 9 окт\.?, 10:05$/);
    expect(alertStamp({ type: 'road_closure', at: '2026-10-01T06:05:00Z', until: '2026-10-20T00:00:00Z' })).toMatch(/^действует до 20 окт\.?$/);
  });

  it('ручной ввод в админке — manual, и при создании, и у существующего пункта', () => {
    const create = read('app/api/admin/external-alerts/route.ts');
    expect(create).toMatch(/basisTitle: z\.string\(\)/);
    expect(create).toMatch(/CASE WHEN \$9::text IS NULL THEN NULL ELSE 'manual' END/);
    const patch = read('app/api/admin/external-alerts/[id]/route.ts');
    expect(patch).toMatch(/export async function PATCH/);
    expect(patch).toMatch(/requireAdmin\(request\)/);
    expect(patch).toMatch(/basis_origin = CASE WHEN \$2::text IS NULL THEN NULL ELSE 'manual' END/);
  });
});

describe('раннер и сервер: снимок — по запросу сервера и только с CDN Telegram', () => {
  const wf = read('.github/workflows/cron-safety-ingest.yml');

  it('раннер читает канал и отдаёт страницу полем pravonarul_html', () => {
    expect(wf).toMatch(/"https:\/\/t\.me\/s\/pravonarul" > \/tmp\/pravonarul\.html/);
    expect(wf).toMatch(/\{pravonarul_html: \$pravonarul_html\}/);
  });

  it('снимки — из ответа сервера (road_basis_needed), только CDN Telegram, шаг не роняет приём', () => {
    expect(wf).toMatch(/\.road_basis_needed \/\/ \[\]/);
    expect(wf).toMatch(/case "\$URL" in https:\/\/cdn\*\.telesco\.pe\/file\/\*\)/);
    expect(wf).toMatch(/"https:\/\/vedarai\.ru\/api\/cron\/road-basis"/);
    const step = wf.slice(wf.indexOf('- name: Road basis'));
    expect(step).toMatch(/continue-on-error: true/);
  });

  it('приём отдаёт список непроверенных, сам модель не зовёт', () => {
    const ingest = read('app/api/cron/safety-ingest/route.ts');
    expect(ingest).toMatch(/pravonarul_html: z\.string\(\)\.max\(2_000_000\)\.optional\(\)/);
    expect(ingest).toMatch(/road_basis_needed: extras\?\.roadBasisNeeded \?\? \[\]/);
    expect(ingest).toMatch(/from '@\/lib\/safety\/road-basis-queue'/);
    expect(ingest).not.toMatch(/from '@\/lib\/safety\/road-basis'/);
    expect(read('lib/safety/road-basis-queue.ts')).not.toMatch(/lib\/ai\//);
  });

  it('роут снимков: секрет крона, адрес снимка с CDN Telegram, только непроверенные посты', () => {
    const route = read('app/api/cron/road-basis/route.ts');
    expect(route).toMatch(/timingSafeCompare\(getCronSecret\(req\)/);
    expect(route).toMatch(/photo_url: z\.string\(\)\.max\(2048\)\.regex\(TELEGRAM_PHOTO_RE\)/);
    expect(route).toMatch(/if \(!pending\.has\(photo\.external_id\)\)/);
    expect(channel.TELEGRAM_PHOTO_RE.test('https://cdn4.telesco.pe/file/abc.jpg')).toBe(true);
    for (const bad of ['http://cdn4.telesco.pe/file/a.jpg', 'https://cdn4.telesco.pe.evil.com/file/a', 'https://evil.com/cdn4.telesco.pe/file/a', 'https://cdn4.telesco.pe/other/a']) {
      expect(channel.TELEGRAM_PHOTO_RE.test(bad), bad).toBe(false);
    }
  });
});
