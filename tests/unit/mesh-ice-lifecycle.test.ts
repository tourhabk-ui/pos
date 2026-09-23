/**
 * VolcanoMesh: буфер ранних ICE-кандидатов и мягкий disconnect (#1993).
 *
 * В мобильных сетях (LTE/CGNAT — типичный случай в поле) сигнальные
 * сообщения обгоняют друг друга: `ice` приходит раньше `offer`/`answer`,
 * и `addIceCandidate` бросает InvalidStateError. До #1993 отказ глушился
 * `.catch(() => {})` — кандидат терялся, соединение не собиралось или
 * собиралось через худший маршрут. А `disconnected` (временное состояние
 * WebRTC, восстанавливается само за секунды) убивал peer мгновенно и без
 * `pc.close()` — утечка сокета у соседа, который через две секунды был бы
 * снова на связи и мог оказаться единственным ретранслятором SOS.
 *
 * RTCPeerConnection в jsdom нет — здесь его заменяет FakePC с тем же
 * контрактом на границе: бросает InvalidStateError без remoteDescription,
 * как браузер.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VolcanoMesh } from '@/lib/mesh/volcano-mesh';

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send = vi.fn();
  close(): void {
    this.closed = true;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePC {
  static instances: FakePC[] = [];
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: RTCDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  added: RTCIceCandidateInit[] = [];
  closed = false;

  constructor() {
    FakePC.instances.push(this);
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = sdp;
  }
  async setLocalDescription(): Promise<void> {}
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'o' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'a' };
  }
  createDataChannel(): RTCDataChannel {
    return new FakeChannel() as unknown as RTCDataChannel;
  }
  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) {
      throw new DOMException('remote description not set', 'InvalidStateError');
    }
    this.added.push(c);
  }
  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
  /** Тестовый рычаг: браузер меняет состояние сам, здесь — мы. */
  setState(s: RTCPeerConnectionState): void {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

/** Приватное — через структурный тип, не через any (правило репозитория). */
interface MeshInternals {
  handleSignal(msg: Record<string, unknown>): Promise<void>;
  pcs: Map<string, RTCPeerConnection>;
  channels: Map<string, RTCDataChannel>;
  peers: Map<string, unknown>;
  pendingCandidates: Map<string, RTCIceCandidateInit[]>;
  disconnectTimers: Map<string, unknown>;
}
const internals = (m: VolcanoMesh): MeshInternals => m as unknown as MeshInternals;

const P = 'peer-a';
const cand = (n: number): RTCIceCandidateInit => ({ candidate: `candidate:${n}`, sdpMid: '0' });

let mesh: VolcanoMesh;
let onPeer: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.instances = [];
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
  mesh = new VolcanoMesh();
  onPeer = vi.fn();
  mesh.onPeer(onPeer);
});

afterEach(() => {
  mesh.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ранние ICE-кандидаты не теряются', () => {
  it('кандидат ДО offer (сторона ответчика) буферится и применяется после SDP', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'ice', from: P, candidate: cand(1) });
    expect(m.pendingCandidates.get(P)).toHaveLength(1);
    expect(FakePC.instances).toHaveLength(0);

    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    const pc = FakePC.instances[0]!;
    expect(pc.added).toEqual([cand(1)]);
    expect(m.pendingCandidates.has(P)).toBe(false);
  });

  it('кандидат ПОСЛЕ offer, но до answer (сторона инициатора) буферится и применяется после answer', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'room-peers', peers: [P] });
    const pc = FakePC.instances[0]!;
    expect(pc.remoteDescription).toBeNull();

    await m.handleSignal({ type: 'ice', from: P, candidate: cand(1) });
    expect(pc.added).toHaveLength(0);
    expect(m.pendingCandidates.get(P)).toHaveLength(1);

    await m.handleSignal({ type: 'answer', from: P, sdp: { type: 'answer', sdp: 'y' } });
    expect(pc.added).toEqual([cand(1)]);
    expect(m.pendingCandidates.has(P)).toBe(false);
  });

  it('после remoteDescription кандидат идёт напрямую, минуя буфер', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    await m.handleSignal({ type: 'ice', from: P, candidate: cand(2) });
    expect(FakePC.instances[0]!.added).toEqual([cand(2)]);
    expect(m.pendingCandidates.size).toBe(0);
  });

  it('буфер ограничен: шторм кандидатов от peer без offer не растёт бесконечно', async () => {
    const m = internals(mesh);
    for (let i = 0; i < 100; i++) {
      await m.handleSignal({ type: 'ice', from: 'ghost', candidate: cand(i) });
    }
    expect(m.pendingCandidates.get('ghost')!.length).toBeLessThanOrEqual(64);
  });
});

describe('disconnect: пауза перед уборкой', () => {
  async function connectedPeer(): Promise<FakePC> {
    await internals(mesh).handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    const pc = FakePC.instances[0]!;
    pc.setState('connected');
    return pc;
  }

  it('короткий провал (< 4 с) не убивает peer, а восстановление снимает таймер', async () => {
    const m = internals(mesh);
    const pc = await connectedPeer();
    pc.setState('disconnected');
    expect(m.disconnectTimers.has(P)).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(m.pcs.get(P)).toBe(pc);
    expect(pc.closed).toBe(false);

    pc.setState('connected');
    expect(m.disconnectTimers.has(P)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(m.pcs.get(P)).toBe(pc);
    expect(pc.closed).toBe(false);
  });

  it('провал дольше 4 с — уборка целиком: pc.close(), карты чисты, UI уведомлён', async () => {
    const m = internals(mesh);
    const pc = await connectedPeer();
    await m.handleSignal({ type: 'ice', from: P, candidate: cand(9) });
    pc.setState('disconnected');

    vi.advanceTimersByTime(4000);
    expect(pc.closed).toBe(true);
    expect(m.pcs.has(P)).toBe(false);
    expect(m.channels.has(P)).toBe(false);
    expect(m.peers.has(P)).toBe(false);
    expect(m.pendingCandidates.has(P)).toBe(false);
    expect(m.disconnectTimers.has(P)).toBe(false);
    expect(onPeer).toHaveBeenLastCalledWith(P, null);
  });

  it('failed — уборка сразу, без паузы', async () => {
    const m = internals(mesh);
    const pc = await connectedPeer();
    pc.setState('failed');
    expect(pc.closed).toBe(true);
    expect(m.pcs.has(P)).toBe(false);
  });
});

describe('ресурсы освобождаются везде, а не только по таймеру', () => {
  it('peer-left закрывает RTCPeerConnection (вторая дверь той же утечки)', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    const pc = FakePC.instances[0]!;
    await m.handleSignal({ type: 'peer-left', deviceId: P });
    expect(pc.closed).toBe(true);
    expect(m.pcs.has(P)).toBe(false);
  });

  it('повторный offer от того же peer закрывает прежний pc, а не оставляет сиротой', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x2' } });
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[0]!.closed).toBe(true);
    expect(m.pcs.get(P)).toBe(FakePC.instances[1]);
  });

  it('stop() не оставляет ни таймеров, ни буферов', async () => {
    const m = internals(mesh);
    await m.handleSignal({ type: 'offer', from: P, sdp: { type: 'offer', sdp: 'x' } });
    FakePC.instances[0]!.setState('disconnected');
    await m.handleSignal({ type: 'ice', from: 'ghost', candidate: cand(1) });
    expect(m.disconnectTimers.size).toBe(1);
    expect(m.pendingCandidates.size).toBe(1);

    mesh.stop();
    expect(m.disconnectTimers.size).toBe(0);
    expect(m.pendingCandidates.size).toBe(0);
    expect(FakePC.instances[0]!.closed).toBe(true);
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
