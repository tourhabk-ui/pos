'use client';

import type { MeshMessage, MeshMessageType, MeshPeer, MeshStatus, SosBroadcastPayload } from './types';
import { roomOf } from './rooms';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function genDeviceId(): string {
  return crypto.randomUUID();
}

type PeerHandler = (peerId: string, peer: MeshPeer) => void;
type MessageHandler = (msg: MeshMessage) => void;

interface PeerPosition {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

export class VolcanoMesh {
  readonly deviceId: string;
  private room = '';
  private sse: EventSource | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private peers = new Map<string, MeshPeer>();

  private onStatusChange?: (s: MeshStatus) => void;
  private onPeersChange?: PeerHandler;
  private onMessage?: MessageHandler;

  private positionInterval: ReturnType<typeof setInterval> | null = null;
  private currentPosition?: PeerPosition;

  private currentLat = 0;
  private currentLng = 0;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') throw new Error('VolcanoMesh: client only');
    this.deviceId = localStorage.getItem('mesh-device-id') ?? genDeviceId();
    localStorage.setItem('mesh-device-id', this.deviceId);
  }

  onStatus(fn: (s: MeshStatus) => void): void {
    this.onStatusChange = fn;
  }

  onPeer(fn: PeerHandler): void {
    this.onPeersChange = fn;
  }

  onMsg(fn: MessageHandler): void {
    this.onMessage = fn;
  }

  async start(lat: number, lng: number): Promise<void> {
    this.currentLat = lat;
    this.currentLng = lng;
    this.currentPosition = { lat, lng, accuracy: 10, timestamp: Date.now() };
    this.room = roomOf(lat, lng);
    this.onStatusChange?.('connecting');

    const url = `/api/mesh/signal?deviceId=${encodeURIComponent(this.deviceId)}&room=${encodeURIComponent(this.room)}`;
    this.sse = new EventSource(url);

    this.sse.onopen = () => {
      this.reconnectDelay = 1000;
      this.onStatusChange?.('connected');
    };
    this.sse.onerror = () => this.scheduleReconnect();

    this.sse.onmessage = (e: MessageEvent<string>) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.handleSignal(msg);
    };

    this.positionInterval = setInterval(() => this.broadcastPosition(), 10000);
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 1000;
    if (this.sse) {
      this.sse.onmessage = null;
      this.sse.onopen = null;
      this.sse.onerror = null;
      this.sse.close();
      this.sse = null;
    }
    if (this.positionInterval) clearInterval(this.positionInterval);
    this.pcs.forEach((pc) => pc.close());
    this.pcs.clear();
    this.channels.clear();
    this.peers.clear();
    this.onStatusChange?.('idle');
  }

  private scheduleReconnect(): void {
    if (this.sse) {
      this.sse.onmessage = null;
      this.sse.onopen = null;
      this.sse.onerror = null;
      this.sse.close();
      this.sse = null;
    }
    this.onStatusChange?.('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(this.currentLat, this.currentLng);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private async handleSignal(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    if (type === 'room-peers') {
      const peers = msg.peers as string[];
      for (const peerId of peers) {
        await this.createOffer(peerId);
      }
    } else if (type === 'peer-left') {
      const peerId = msg.deviceId as string;
      this.pcs.get(peerId)?.close();
      this.pcs.delete(peerId);
      this.channels.delete(peerId);
      this.peers.delete(peerId);
      this.onPeersChange?.(peerId, null as unknown as MeshPeer);
    } else if (type === 'offer') {
      await this.handleOffer(
        msg.from as string,
        msg.sdp as RTCSessionDescriptionInit,
      );
    } else if (type === 'answer') {
      await this.handleAnswer(
        msg.from as string,
        msg.sdp as RTCSessionDescriptionInit,
      );
    } else if (type === 'ice') {
      await this.handleIce(
        msg.from as string,
        msg.candidate as RTCIceCandidateInit,
      );
    }
  }

  private async relay(to: string, message: unknown): Promise<void> {
    await fetch('/api/mesh/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message }),
    }).catch(() => {});
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pcs.set(peerId, pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        void this.relay(peerId, {
          type: 'ice',
          from: this.deviceId,
          candidate: candidate.toJSON(),
        });
      }
    };

    pc.ondatachannel = ({ channel }) => {
      this.setupChannel(peerId, channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        this.pcs.delete(peerId);
        this.channels.delete(peerId);
        this.peers.delete(peerId);
        this.onPeersChange?.(peerId, null as unknown as MeshPeer);
      }
    };

    return pc;
  }

  private setupChannel(peerId: string, channel: RTCDataChannel): void {
    this.channels.set(peerId, channel);

    channel.onopen = () => {
      this.sendToPeer(peerId, {
        type: 'position' as MeshMessageType,
        from: this.deviceId,
        payload: this.currentPosition,
        timestamp: Date.now(),
      });
      // SOS, нажатый до установления связи, уходит первым же каналом
      this.flushPendingSos();
    };

    channel.onmessage = ({ data }: MessageEvent<string>) => {
      let msg: MeshMessage;
      try {
        msg = JSON.parse(data) as MeshMessage;
      } catch {
        return;
      }
      this.handleDataMessage(peerId, msg);
    };

    channel.onclose = () => {
      this.channels.delete(peerId);
    };
  }

  private async createOffer(peerId: string): Promise<void> {
    const pc = this.createPeerConnection(peerId);
    const channel = pc.createDataChannel('volcano', { ordered: false, maxRetransmits: 2 });
    this.setupChannel(peerId, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.relay(peerId, { type: 'offer', from: this.deviceId, sdp: offer });
  }

  private async handleOffer(
    peerId: string,
    sdp: RTCSessionDescriptionInit,
  ): Promise<void> {
    const pc = this.createPeerConnection(peerId);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.relay(peerId, { type: 'answer', from: this.deviceId, sdp: answer });
  }

  private async handleAnswer(
    peerId: string,
    sdp: RTCSessionDescriptionInit,
  ): Promise<void> {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
  }

  private async handleIce(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  private handleDataMessage(peerId: string, msg: MeshMessage): void {
    if (msg.type === 'position') {
      const payload = msg.payload as PeerPosition | undefined;
      const existing = this.peers.get(peerId);
      const peer: MeshPeer = {
        deviceId: peerId,
        lastSeen: Date.now(),
        ...existing,
      };
      if (payload) peer.position = payload;
      this.peers.set(peerId, peer);
      this.onPeersChange?.(peerId, peer);
    } else if (msg.type === 'ping') {
      this.sendToPeer(peerId, {
        type: 'pong',
        from: this.deviceId,
        payload: null,
        timestamp: Date.now(),
      });
    } else if (msg.type === 'sos' && typeof navigator !== 'undefined' && navigator.onLine) {
      // Я онлайн — ретранслирую SOS соседа на сервер. Дедуп копий от
      // нескольких ретрансляторов — на /api/mesh/sos-relay (по sos_id).
      const p = (typeof msg.payload === 'object' && msg.payload !== null
        ? msg.payload
        : {}) as Partial<SosBroadcastPayload> & { position?: PeerPosition };
      const sos = p.sos ?? {
        // Обратная совместимость со старым форматом {position, deviceId}
        lat: p.position?.lat ?? null,
        lng: p.position?.lng ?? null,
        accuracy: p.position?.accuracy ?? null,
      };
      // Фолбэк sos_id для старого формата: from+timestamp дедуплицирует
      // копии одного сообщения; без timestamp — случайный (дубль лучше потери)
      const sosId = p.sos_id
        ?? (typeof msg.timestamp === 'number' ? `${msg.from}-${msg.timestamp}` : crypto.randomUUID());
      const relayDirect = () => fetch('/api/safety/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sos, relayed_by: this.deviceId, source: 'mesh_relay' }),
      }).catch(() => {});
      void fetch('/api/mesh/sos-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sos_id: sosId,
          relayed_by: this.deviceId,
          origin_device: msg.from,
          sos,
        }),
      }).then((res) => {
        // Релей-эндпоинт недоступен (откат деплоя, 5xx) — доставляем
        // напрямую в канонический роут: дубль лучше потерянного SOS
        if (res.status === 404 || res.status >= 500) void relayDirect();
      }).catch(() => { void relayDirect(); });
    }

    this.onMessage?.(msg);
  }

  private sendToPeer(peerId: string, msg: MeshMessage): void {
    const ch = this.channels.get(peerId);
    if (ch?.readyState === 'open') {
      ch.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: Omit<MeshMessage, 'from'>): void {
    const full: MeshMessage = { ...msg, from: this.deviceId };
    for (const [peerId] of this.channels) {
      this.sendToPeer(peerId, full);
    }
  }

  updatePosition(lat: number, lng: number, accuracy: number): void {
    this.currentPosition = { lat, lng, accuracy, timestamp: Date.now() };
  }

  broadcastPosition(): void {
    if (!this.currentPosition) return;
    this.broadcast({ type: 'position', payload: this.currentPosition, timestamp: Date.now() });
  }

  /**
   * Разослать SOS всем соседям по мешу. sos_id генерируется здесь —
   * по нему сервер дедуплицирует копии от нескольких ретрансляторов.
   *
   * Надёжность поверх ненадёжного канала (maxRetransmits: 2):
   * - если открытых каналов нет — сигнал ждёт в pendingSos и уходит,
   *   как только первый канал откроется (паника: жмут SOS раньше,
   *   чем WebRTC успел договориться);
   * - повторная рассылка через 2с и 6с — дубли бесплатны, сервер
   *   дедуплицирует по sos_id.
   */
  private pendingSos: SosBroadcastPayload | null = null;

  sendSOS(sos?: Partial<SosBroadcastPayload['sos']>): string {
    const sosId = crypto.randomUUID();
    const fields = {
      // Координаты формы; фолбэк — последняя известная позиция меша
      // (для спасателей устаревший фикс лучше, чем никакого)
      lat: sos?.lat ?? this.currentPosition?.lat ?? null,
      lng: sos?.lng ?? this.currentPosition?.lng ?? null,
      accuracy: sos?.accuracy ?? this.currentPosition?.accuracy ?? null,
      message: sos?.message ?? null,
      tourist_name: sos?.tourist_name ?? null,
      tourist_phone: sos?.tourist_phone ?? null,
    };
    // Поля продублированы на верхнем уровне НАМЕРЕННО: старые
    // закэшированные PWA-ретрансляторы спредят payload прямо в
    // /api/safety/sos — без плоских lat/lng они бы доставили SOS
    // без координат и имени.
    const payload: SosBroadcastPayload = { sos_id: sosId, ...fields, sos: fields };

    this.broadcastSos(payload);
    setTimeout(() => this.broadcastSos(payload), 2000);
    setTimeout(() => this.broadcastSos(payload), 6000);
    return sosId;
  }

  private broadcastSos(payload: SosBroadcastPayload): void {
    if (this.connectedCount === 0) {
      this.pendingSos = payload;
      return;
    }
    this.broadcast({ type: 'sos', payload, timestamp: Date.now() });
  }

  private flushPendingSos(): void {
    if (!this.pendingSos) return;
    const payload = this.pendingSos;
    this.pendingSos = null;
    this.broadcast({ type: 'sos', payload, timestamp: Date.now() });
  }

  getPeers(): MeshPeer[] {
    return Array.from(this.peers.values());
  }

  get connectedCount(): number {
    return Array.from(this.channels.values()).filter((ch) => ch.readyState === 'open').length;
  }
}
