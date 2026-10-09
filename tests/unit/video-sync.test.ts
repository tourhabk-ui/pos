/**
 * Сторож: заливка роликов в хранилище (lib/media/video-sync,
 * lib/media/video-hygiene) — владелец 09.10: «видео тоже в s3».
 *
 * Пока ролики лежали в репозитории, правила владельца («без звука», «без
 * даты и места съёмки») держал тест по самим файлам. Файлы уехали — правила
 * держит заливка: файл, который их нарушает, в хранилище не пишется. Здесь
 * это проверяется поведением, на синтетических файлах и поддельном
 * хранилище:
 *   — недостающее заливается и читается обратно публичным адресом;
 *   — на месте — не перезаливается; чужой файл под ключом — отказ, а не
 *     перезапись (объект кэшируется на год);
 *   — файл со звуком, меткой места или индексом в конце — не пишется;
 *   — залитое, но не читаемое публично, и хранилище без докачки кусками —
 *     отказ; хранилище, не ответившее, — «не смог проверить», а не «на месте».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

type Entry = { sha256: string; bytes: number; type: 'video/mp4' | 'image/jpeg' };
const FILES = vi.hoisted(() => ({}) as Record<string, Entry>);
vi.mock('@/lib/media/video-manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/video-manifest')>()),
  VIDEO_FILES: FILES,
}));

import { mediaProblems, MAX_VIDEO_BYTES } from '@/lib/media/video-hygiene';
import { syncSucceeded, syncVideos, type PublicRead, type SyncIO } from '@/lib/media/video-sync';

// ── Синтетический MP4: коробки верхнего уровня, в moov — обработчики дорожек ──
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
// hdlr: версия и флаги, pre_defined, тип дорожки, резерв, имя.
const hdlr = (kind: 'vide' | 'soun') =>
  box('hdlr', Buffer.alloc(8), Buffer.from(kind, 'latin1'), Buffer.alloc(12), Buffer.from('Handler\0', 'latin1'));
const FTYP = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1'));

function mp4(opts: { audio?: boolean; udta?: string; mdatFirst?: boolean; frames?: Buffer } = {}): Buffer {
  const moov = box('moov',
    box('trak', box('mdia', hdlr('vide'))),
    ...(opts.audio ? [box('trak', box('mdia', hdlr('soun')))] : []),
    ...(opts.udta ? [box('udta', Buffer.from(opts.udta, 'latin1'))] : []));
  const mdat = box('mdat', opts.frames ?? Buffer.alloc(64, 7));
  return Buffer.concat(opts.mdatFirst ? [FTYP, mdat, moov] : [FTYP, moov, mdat]);
}

const jpeg = (exif = false) => {
  const img = sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 51, g: 102, b: 153 } } });
  return (exif ? img.withExif({ IFD0: { Copyright: 'проба' } }) : img).jpeg().toBuffer();
};

describe('годится ли файл в хранилище', () => {
  it('чистый ролик — годится', () => {
    expect(mediaProblems(mp4(), 'video/mp4')).toEqual([]);
  });

  it('звуковая дорожка — отказ (решение владельца 09.10)', () => {
    expect(mediaProblems(mp4({ audio: true }), 'video/mp4')).toContain('есть звуковая дорожка');
  });

  it('метка места в служебных коробках — отказ; те же байты в кадрах — не тревога', () => {
    expect(mediaProblems(mp4({ udta: '\xa9xyz+53.0+158.6/' }), 'video/mp4').join()).toMatch(/следы съёмки/);
    expect(mediaProblems(mp4({ udta: 'com.apple.quicktime.location.ISO6709' }), 'video/mp4').join()).toMatch(/следы съёмки/);
    expect(mediaProblems(mp4({ frames: Buffer.from('\xa9xyz location', 'latin1') }), 'video/mp4')).toEqual([]);
  });

  it('индекс после данных — отказ: браузер не начнёт играть, пока не докачает конец', () => {
    expect(mediaProblems(mp4({ mdatFirst: true }), 'video/mp4').join()).toMatch(/faststart/);
  });

  it('обрезанный файл и не MP4 — отказ', () => {
    const whole = mp4();
    expect(mediaProblems(whole.subarray(0, whole.length - 10), 'video/mp4')).toEqual(['не MP4 или файл обрезан']);
    expect(mediaProblems(Buffer.from('<html>не ролик</html>'), 'video/mp4')).toEqual(['не MP4 или файл обрезан']);
  });

  it('тяжелее потолка — отказ', () => {
    expect(mediaProblems(mp4({ frames: Buffer.alloc(MAX_VIDEO_BYTES) }), 'video/mp4').join()).toMatch(/потолок/);
  });

  it('обложка: чистая — годится, с EXIF — отказ', async () => {
    expect(mediaProblems(await jpeg(), 'image/jpeg')).toEqual([]);
    expect(mediaProblems(await jpeg(true), 'image/jpeg')).toContain('EXIF в обложке');
    expect(mediaProblems(Buffer.from('не картинка'), 'image/jpeg')).toEqual(['не JPEG']);
  });
});

// ── Поддельное хранилище ─────────────────────────────────────────────────────

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const CLIP = '/video/t/clip.mp4';
const POSTER = '/video/t/clip.poster.jpg';
let local: Record<string, Buffer> = {};
let store: Record<string, { body: Buffer; type: string }> = {};
let puts: string[] = [];
let opts: { down?: boolean; privateAfterPut?: boolean; range?: number } = {};

function put(path: string, body: Buffer, type: Entry['type']) {
  FILES[path] = { sha256: sha(body), bytes: body.length, type };
  local[path] = body;
}

const io: SyncIO = {
  readLocal: async (p) => local[p] ?? null,
  readPublic: async (key): Promise<PublicRead> => {
    if (opts.down) return { status: 503, type: null, body: null };
    const o = store[key];
    if (!o || (opts.privateAfterPut && puts.includes(key))) return { status: 403, type: null, body: null };
    return { status: 200, type: o.type, body: o.body };
  },
  rangeStatus: async () => opts.range ?? 206,
  put: async (key, body, type) => { puts.push(key); store[key] = { body, type }; },
};

beforeEach(async () => {
  for (const k of Object.keys(FILES)) delete FILES[k];
  local = {}; store = {}; puts = []; opts = {};
  put(CLIP, mp4(), 'video/mp4');
  put(POSTER, await jpeg(), 'image/jpeg');
});

describe('заливка: залить недостающее, прочитать обратно всё', () => {
  it('хранилище пустое — оба файла залиты под ключом без косой и прочитаны обратно', async () => {
    const out = await syncVideos(io, { upload: true });
    expect(out).toEqual([{ path: CLIP, status: 'uploaded' }, { path: POSTER, status: 'uploaded' }]);
    expect(puts).toEqual(['video/t/clip.mp4', 'video/t/clip.poster.jpg']);
    expect(store['video/t/clip.mp4']!.type).toBe('video/mp4');
    expect(syncSucceeded(out)).toBe(true);
  });

  it('на месте — не перезаливается; файла в репозитории для этого не нужно', async () => {
    await syncVideos(io, { upload: true });
    puts = []; local = {};
    const out = await syncVideos(io, { upload: true });
    expect(out.map((o) => o.status)).toEqual(['in_place', 'in_place']);
    expect(puts).toEqual([]);
  });

  it('сухой прогон — ничего не пишет и называет, что зальёт', async () => {
    const out = await syncVideos(io, { upload: false });
    expect(out.map((o) => o.status)).toEqual(['would_upload', 'would_upload']);
    expect(puts).toEqual([]);
  });

  it('нет ни в хранилище, ни в репозитории — отказ прогона', async () => {
    local = {};
    const out = await syncVideos(io, { upload: true });
    expect(out[0]).toMatchObject({ status: 'failed', reason: 'нет ни в хранилище, ни в репозитории' });
    expect(syncSucceeded(out)).toBe(false);
  });

  it('под ключом другой файл — отказ, а не перезапись', async () => {
    store['video/t/clip.mp4'] = { body: mp4({ frames: Buffer.alloc(64, 9) }), type: 'video/mp4' };
    const out = await syncVideos(io, { upload: true });
    expect(out[0]).toMatchObject({ status: 'failed' });
    expect((out[0] as { reason: string }).reason).toMatch(/другой файл/);
    expect(puts).not.toContain('video/t/clip.mp4');
  });

  it('файл со звуком в хранилище не пишется', async () => {
    put(CLIP, mp4({ audio: true }), 'video/mp4');
    const out = await syncVideos(io, { upload: true });
    expect((out[0] as { reason: string }).reason).toMatch(/звуковая дорожка/);
    expect(puts).not.toContain('video/t/clip.mp4');
  });

  it('файл в репозитории разошёлся с манифестом — не пишется', async () => {
    local[CLIP] = mp4({ frames: Buffer.alloc(64, 1) });
    const out = await syncVideos(io, { upload: true });
    expect((out[0] as { reason: string }).reason).toMatch(/не совпадает с манифестом/);
    expect(puts).not.toContain('video/t/clip.mp4');
  });

  it('залит, но публично не читается — отказ: так его не увидит и браузер', async () => {
    opts.privateAfterPut = true;
    const out = await syncVideos(io, { upload: true });
    expect((out[0] as { reason: string }).reason).toMatch(/публично не читается: HTTP 403/);
  });

  it('хранилище без докачки кусками — отказ для ролика, обложке не нужна', async () => {
    opts.range = 200;
    const out = await syncVideos(io, { upload: true });
    expect((out[0] as { reason: string }).reason).toMatch(/Range → HTTP 200/);
    expect(out[1]).toEqual({ path: POSTER, status: 'uploaded' });
  });

  it('не тот тип в ответе хранилища — отказ', async () => {
    store['video/t/clip.mp4'] = { body: local[CLIP]!, type: 'application/octet-stream' };
    const out = await syncVideos(io, { upload: true });
    expect((out[0] as { reason: string }).reason).toMatch(/тип «application\/octet-stream»/);
  });

  it('хранилище не ответило — «не смог проверить», ничего не пишется', async () => {
    opts.down = true;
    const out = await syncVideos(io, { upload: true });
    expect(out.every((o) => o.status === 'failed' && /проверить не смог/.test(o.reason))).toBe(true);
    expect(puts).toEqual([]);
    expect(syncSucceeded(out)).toBe(false);
  });

  it('пустой манифест — отказ, а не успех (§4.0)', () => {
    expect(syncSucceeded([])).toBe(false);
  });
});
