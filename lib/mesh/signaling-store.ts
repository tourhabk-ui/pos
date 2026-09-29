// Used ONLY via app/api/mesh/signal/route.ts — never import in client code

import { roomsAreNeighbors } from './rooms';

const encoder = new TextEncoder();

interface SignalingConn {
  deviceId: string;
  room: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Адрес, с которого открыт поток; null — не установлен. */
  ip: string | null;
}

// Global singleton — works within a single Docker process
const globalForMesh = globalThis as typeof globalThis & {
  _meshConnections?: Map<string, SignalingConn>;
};
if (!globalForMesh._meshConnections) {
  globalForMesh._meshConnections = new Map();
}
const connections = globalForMesh._meshConnections;

/** Жив ли поток: запись в закрытый поток бросает. */
function isAlive(conn: SignalingConn): boolean {
  try {
    conn.controller.enqueue(encoder.encode(': ping\n\n'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Зарегистрировать устройство. `false` — занято: этот deviceId уже держит
 * ЖИВОЙ поток с другого адреса.
 *
 * Проверка безопасности 29.09 (#2073): раньше новая регистрация молча
 * перезаписывала старую. Узнав чужой deviceId (он приходит всем соседям в
 * `room-peers`), любой мог открыть поток под ним и получать адресованный ему
 * сигналинг — в том числе обмен, через который сосед доносит SOS. Замена
 * разрешена, когда это похоже на переподключение того же человека: тот же
 * адрес либо старый поток уже мёртв.
 */
export function registerDevice(
  deviceId: string,
  room: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  ip: string | null = null,
): boolean {
  const prev = connections.get(deviceId);
  if (prev && prev.controller !== controller && prev.ip !== ip && isAlive(prev)) {
    return false;
  }
  connections.set(deviceId, { deviceId, room, controller, ip });
  broadcastToRoom(room, { type: 'peer-joined', deviceId }, deviceId);
  return true;
}

/** Где зарегистрировано устройство; null — не на связи. */
export function roomOfDevice(deviceId: string): string | null {
  return connections.get(deviceId)?.room ?? null;
}

/**
 * Снять устройство. С `controller` снимается только ЭТОТ поток: закрытие
 * старого соединения после быстрого переподключения не должно выбрасывать
 * новое (раньше выбрасывало — сосед пропадал из меша до следующего входа).
 */
export function removeDevice(
  deviceId: string,
  controller?: ReadableStreamDefaultController<Uint8Array>,
): void {
  const conn = connections.get(deviceId);
  if (conn && (!controller || conn.controller === controller)) {
    broadcastToRoom(conn.room, { type: 'peer-left', deviceId }, deviceId);
    connections.delete(deviceId);
  }
}

export function sendToDevice(targetId: string, message: unknown): boolean {
  const conn = connections.get(targetId);
  if (!conn) return false;
  try {
    conn.controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
    return true;
  } catch {
    connections.delete(targetId);
    return false;
  }
}

// Соседство 3x3 (lib/mesh/rooms.ts): устройства из смежных ячеек видят
// друг друга — иначе граница ячейки разрезала бы группу на маршруте.
export function getRoomPeers(room: string, excludeId?: string): string[] {
  return Array.from(connections.values())
    .filter((c) => roomsAreNeighbors(room, c.room) && c.deviceId !== excludeId)
    .map((c) => c.deviceId);
}

function broadcastToRoom(room: string, message: unknown, excludeId?: string): void {
  // Кадр одинаков для всех получателей — кодируем один раз
  const frame = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
  for (const conn of connections.values()) {
    if (roomsAreNeighbors(room, conn.room) && conn.deviceId !== excludeId) {
      try {
        conn.controller.enqueue(frame);
      } catch {
        connections.delete(conn.deviceId);
      }
    }
  }
}
