/**
 * QR-эстафета SOS: кодирование/разбор payload в URL и маршрутизация
 * офлайн-очереди (чужой SOS → /api/mesh/sos-relay с дедупом, свой →
 * канонический роут). Это транспорт «между двумя офлайн телефонами»
 * через камеру — единственный, который существует в браузере, поэтому
 * его чистая часть закреплена сторожем.
 */
import { describe, it, expect } from 'vitest';
import { buildRelayUrl, parseRelayHash, type QrSosPayload } from '@/lib/mesh/qr-relay';
import { requestFor, flushPendingItems, type PendingSOS } from '@/lib/offline/pending-queue';

const FULL: QrSosPayload = {
  sos_id: 'a1b2c3d4-0000-4000-8000-000000000000',
  lat: 53.263591234,
  lng: 158.416442345,
  accuracy: 12.7,
  tourist_name: 'Иван Петров',
  tourist_phone: '+79991234567',
  message: 'Подвернул ногу у перевала',
  shown_at: 1756400000000,
};

describe('QR-эстафета: URL туда и обратно', () => {
  it('полный payload переживает round-trip без потерь смысла', () => {
    const url = buildRelayUrl('https://vedarai.ru', FULL);
    const hash = new URL(url).hash;
    const parsed = parseRelayHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.sos_id).toBe(FULL.sos_id);
    expect(parsed!.lat).toBeCloseTo(FULL.lat!, 5);
    expect(parsed!.lng).toBeCloseTo(FULL.lng!, 5);
    expect(parsed!.tourist_name).toBe(FULL.tourist_name);
    expect(parsed!.tourist_phone).toBe(FULL.tourist_phone);
    expect(parsed!.message).toBe(FULL.message);
    expect(parsed!.shown_at).toBe(FULL.shown_at);
  });

  it('координаты самоописываются в query — видны в превью камеры без открытия', () => {
    const url = new URL(buildRelayUrl('https://vedarai.ru', FULL));
    expect(url.pathname).toBe('/sos/relay');
    expect(url.searchParams.get('ll')).toBe('53.26359,158.41644');
  });

  it('ПД (имя, телефон) — только в hash, не в query: фрагмент не уходит на сервер', () => {
    const url = buildRelayUrl('https://vedarai.ru', FULL);
    const [beforeHash] = url.split('#');
    expect(beforeHash).not.toContain('79991234567');
    expect(beforeHash.toLowerCase()).not.toContain(encodeURIComponent('Иван').toLowerCase());
  });

  it('payload без координат: нет ll в query, разбор возвращает null-координаты', () => {
    const noCoords: QrSosPayload = { ...FULL, lat: null, lng: null, accuracy: null };
    const url = buildRelayUrl('https://vedarai.ru', noCoords);
    expect(url).not.toContain('?ll=');
    const parsed = parseRelayHash(new URL(url).hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.lat).toBeNull();
    expect(parsed!.lng).toBeNull();
  });

  it('мусор в hash — null, а не выдуманный сигнал (§4.0)', () => {
    expect(parseRelayHash('')).toBeNull();
    expect(parseRelayHash('#p=')).toBeNull();
    expect(parseRelayHash('#p=%%%%')).toBeNull();
    expect(parseRelayHash('#p=bm90LWpzb24')).toBeNull(); // "not-json"
    // валидный base64url, но JSON без обязательного sos_id
    const noId = Buffer.from(JSON.stringify({ t: 1 })).toString('base64url');
    expect(parseRelayHash(`#p=${noId}`)).toBeNull();
  });

  it('координаты вне диапазона отвергаются целиком', () => {
    const bad = Buffer.from(JSON.stringify({
      i: 'a1b2c3d4-0000', t: 1, a: 95, o: 158.4,
    })).toString('base64url');
    expect(parseRelayHash(`#p=${bad}`)).toBeNull();
  });

  it('URL помещается в разумную ёмкость QR (< 600 символов на полном payload)', () => {
    expect(buildRelayUrl('https://vedarai.ru', FULL).length).toBeLessThan(600);
  });
});

describe('офлайн-очередь: маршрутизация чужого и своего SOS', () => {
  const base = {
    id: 'sos_1', queuedAt: 1,
    lat: 53.1, lng: 158.2, accuracy: 10,
    tourist_name: 'Имя', tourist_phone: '+79990000000',
  };

  it('свой SOS уходит в канонический /api/safety/sos', () => {
    const { url, body } = requestFor(base as PendingSOS);
    expect(url).toBe('/api/safety/sos');
    expect(JSON.parse(body)).not.toHaveProperty('sos_id');
  });

  it('чужой SOS (relay) уходит в /api/mesh/sos-relay с sos_id пострадавшего', () => {
    const item: PendingSOS = {
      ...base,
      message: 'помогите',
      relay: { sos_id: 'victim-sos-id-123', relayed_by: 'qr:device-1', origin_device: 'dev-0' },
    };
    const { url, body } = requestFor(item);
    expect(url).toBe('/api/mesh/sos-relay');
    const parsed = JSON.parse(body) as {
      sos_id: string; relayed_by: string;
      sos: { lat: number; message: string | null };
    };
    expect(parsed.sos_id).toBe('victim-sos-id-123');
    expect(parsed.relayed_by).toBe('qr:device-1');
    expect(parsed.sos.lat).toBe(53.1);
    expect(parsed.sos.message).toBe('помогите');
  });

  it('флаш удаляет доставленные и 429 (дедуп), хранит недоставленные', async () => {
    const items = [
      { ...base, id: 'a' },
      { ...base, id: 'b' },
      { ...base, id: 'c' },
    ] as PendingSOS[];
    const removed: string[] = [];
    const codes: Record<string, { ok: boolean; status: number }> = {
      a: { ok: true, status: 200 },
      b: { ok: false, status: 429 },
      c: { ok: false, status: 503 },
    };
    const res = await flushPendingItems(
      items,
      async (item) => codes[item.id],
      async (id) => { removed.push(id); },
    );
    expect(res.sent).toBe(2);
    expect(res.kept).toBe(1);
    expect(removed.sort()).toEqual(['a', 'b']);
  });
});
