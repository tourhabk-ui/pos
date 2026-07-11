export interface MeshPeer {
  deviceId: string;
  nickname?: string;
  position?: { lat: number; lng: number; accuracy: number; timestamp: number };
  battery?: number;
  lastSeen: number;
}

export type MeshMessageType = 'position' | 'sos' | 'ping' | 'pong';

export interface MeshMessage {
  type: MeshMessageType;
  from: string;
  payload: unknown;
  timestamp: number;
}

export type MeshStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'no-gps';

/** Полезная нагрузка SOS-сообщения в меше (payload при type='sos'). */
export interface SosBroadcastPayload {
  /** UUID сигнала — по нему сервер дедуплицирует копии от разных ретрансляторов. */
  sos_id: string;
  deviceId: string;
  position: { lat: number; lng: number; accuracy: number; timestamp: number } | null;
  sos: {
    lat?: number | null;
    lng?: number | null;
    accuracy?: number | null;
    message?: string | null;
    tourist_name?: string | null;
    tourist_phone?: string | null;
  };
}
