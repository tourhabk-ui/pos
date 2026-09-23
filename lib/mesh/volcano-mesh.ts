'use client';

import type { MeshMessage, MeshMessageType, MeshPeer, MeshStatus, SosBroadcastPayload } from './types';
import { roomOf } from './rooms';
import { queueSOS, registerSOSSync } from '@/lib/offline/pending-queue';

// STUN пробивает обычные NAT; за CGNAT мобильных операторов (типичный
// случай в поле) соединение без TURN не собирается вовсе — обе стороны
// онлайн, а канала нет. TURN подключается переменными окружения, когда
// владелец поднимет relay-сервер; без них поведение прежнее (только STUN).
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...(process.env.NEXT_PUBLIC_TURN_URL
    ? [{
        urls: process.env.NEXT_PUBLIC_TURN_URL,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME ?? '',
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '',
      }]
    : []),
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

  // ICE-кандидаты, пришедшие раньше remoteDescription (#1993). В мобильных
  // сетях (LTE/CGNAT — типичный случай в поле) сигнальные сообщения обгоняют
  // друг друга: `ice` приходит до `offer`/`answer`, и addIceCandidate бросает
  // InvalidStateError. Раньше отказ глушился, кандидат терялся, и соединение
  // либо не собиралось, либо собиралось через худший маршрут.
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  // Верхняя граница на peer: кандидатов у соединения обычно меньше тридцати,
  // а буфер по чужому deviceId без offer — иначе бесконечная память.
  private static readonly MAX_PENDING_CANDIDATES = 64;

  // `disconnected` в WebRTC — состояние временное, ICE восстанавливается сам
  // за секунды (смена соты, короткий провал LTE). Убивать peer сразу значило
  // рвать канал у соседа, который через две секунды был бы снова на связи —
  // а он может оказаться единственным ретранслятором SOS.
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DISCONNECT_GRACE_MS = 4000;

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
    this.disconnectTimers.forEach((t) => clearTimeout(t));
    this.disconnectTimers.clear();
    this.pendingCandidates.clear();
    // Каналы раньше соединений: pc.close() закрывает и их, но явно надёжнее.
    this.channels.forEach((ch) => ch.close());
    this.channels.clear();
    this.pcs.forEach((pc) => pc.close());
    this.pcs.clear();
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
      this.cleanupPeerImmediate(msg.deviceId as string);
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
    // Повторный сигналинг того же peer (быстрый reconnect соседа) без этой
    // уборки оставлял прежний RTCPeerConnection сиротой: из карты его
    // вытесняли, но не закрывали.
    if (this.pcs.has(peerId)) this.cleanupPeerImmediate(peerId);
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
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearDisconnectTimer(peerId);
      } else if (state === 'failed' || state === 'closed') {
        this.cleanupPeerImmediate(peerId);
      } else if (state === 'disconnected') {
        this.scheduleDisconnectCleanup(peerId, pc);
      }
    };

    return pc;
  }

  private scheduleDisconnectCleanup(peerId: string, pc: RTCPeerConnection): void {
    this.clearDisconnectTimer(peerId);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(peerId);
      // За время паузы peer могли пересоздать (createPeerConnection) — тогда
      // в карте уже другой pc, и он не наш.
      if (this.pcs.get(peerId) !== pc) return;
      if (pc.connectionState !== 'connected') this.cleanupPeerImmediate(peerId);
    }, this.DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(peerId, timer);
  }

  private clearDisconnectTimer(peerId: string): void {
    const timer = this.disconnectTimers.get(peerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.disconnectTimers.delete(peerId);
  }

  /**
   * Освободить всё, что держит peer. Из карт удаляется ДО close(): если
   * браузер на close() дёрнет обработчик состояния, повторный вход найдёт
   * пустоту, а не зациклится.
   */
  private cleanupPeerImmediate(peerId: string): void {
    this.clearDisconnectTimer(peerId);
    const channel = this.channels.get(peerId);
    this.channels.delete(peerId);
    channel?.close();
    const pc = this.pcs.get(peerId);
    this.pcs.delete(peerId);
    pc?.close();
    this.pendingCandidates.delete(peerId);
    this.peers.delete(peerId);
    this.onPeersChange?.(peerId, null as unknown as MeshPeer);
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
    await this.drainPendingCandidates(peerId, pc);
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
    await this.drainPendingCandidates(peerId, pc);
  }

  private async handleIce(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.pcs.get(peerId);
    if (!pc || !pc.remoteDescription) {
      // Кандидату некуда: SDP ещё не пришёл (у ответчика — и pc ещё нет).
      // Ждёт в буфере, drainPendingCandidates применит после SDP.
      const list = this.pendingCandidates.get(peerId) ?? [];
      if (list.length >= VolcanoMesh.MAX_PENDING_CANDIDATES) list.shift();
      list.push(candidate);
      this.pendingCandidates.set(peerId, list);
      return;
    }
    // После remoteDescription отказ значит «кандидат устарел или битый», а
    // не «потерян»: браузер уже собрал маршрут, потребителя у ошибки нет.
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  private async drainPendingCandidates(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const list = this.pendingCandidates.get(peerId);
    // Снимаем ДО обхода: кандидат, пришедший во время await, уже увидит
    // remoteDescription и уйдёт в pc напрямую, а не в список, который мы льём.
    this.pendingCandidates.delete(peerId);
    if (!list) return;
    for (const candidate of list) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
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
    } else if (msg.type === 'sos') {
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

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        // Я сам офлайн. Раньше сигнал соседа здесь МОЛЧА выбрасывался —
        // ретранслятор без сети был дырой в эстафете. Теперь store-and-forward:
        // чужой SOS ложится в мою офлайн-очередь и уходит через
        // /api/mesh/sos-relay (дедуп по sos_id), когда Я доберусь до связи.
        // Типовой сценарий: сосед по лагерю ловил край соты, у меня пусто,
        // но вниз к покрытию иду я.
        void queueSOS({
          lat: (sos.lat as number | null) ?? null,
          lng: (sos.lng as number | null) ?? null,
          accuracy: (sos.accuracy as number | null) ?? null,
          tourist_name: (('tourist_name' in sos ? sos.tourist_name : null) as string | null) ?? null,
          tourist_phone: (('tourist_phone' in sos ? sos.tourist_phone : null) as string | null) ?? null,
          message: (('message' in sos ? sos.message : null) as string | null) ?? null,
          relay: { sos_id: sosId, relayed_by: this.deviceId, origin_device: msg.from },
        }).then(() => registerSOSSync()).catch(() => {
          // Очередь недоступна (приватный режим, квота) — сигнал хотя бы
          // виден в UI через onMessage ниже; молча его уже не теряем.
        });
      } else {
        // Я онлайн — ретранслирую SOS соседа на сервер. Дедуп копий от
        // нескольких ретрансляторов — на /api/mesh/sos-relay (по sos_id).
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
