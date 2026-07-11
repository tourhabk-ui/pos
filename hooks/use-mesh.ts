'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { VolcanoMesh } from '@/lib/mesh/volcano-mesh';
import { roomOf } from '@/lib/mesh/rooms';
import type { MeshMessage, MeshPeer, MeshStatus, SosBroadcastPayload } from '@/lib/mesh/types';

export function useMesh(
  enabled: boolean,
  position: { lat: number; lng: number } | null,
) {
  const meshRef = useRef<VolcanoMesh | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  // SOS, нажатый до того как меш поднялся (координаты пришли только что) —
  // не теряем, отправим первым делом после старта
  const pendingSosRef = useRef<Partial<SosBroadcastPayload['sos']> | null>(null);
  const [status, setStatus] = useState<MeshStatus>('idle');
  const [peers, setPeers] = useState<Map<string, MeshPeer>>(new Map());
  const [sosPeers, setSosPeers] = useState<MeshMessage[]>([]);
  const [relayedCount, setRelayedCount] = useState(0);

  // Перезапуск меша — ТОЛЬКО при смене геокомнаты, не на каждый сдвиг GPS.
  // Иначе свежий фикс координат в момент отправки SOS рвал бы все каналы
  // ровно тогда, когда они нужны (teardown гонялся с broadcast).
  const room = enabled && position ? roomOf(position.lat, position.lng) : null;

  useEffect(() => {
    if (!room) return;
    const pos = positionRef.current;
    if (!pos) return;

    const mesh = new VolcanoMesh();
    meshRef.current = mesh;

    mesh.onStatus(setStatus);
    mesh.onPeer((peerId, peer) => {
      setPeers((prev) => {
        const next = new Map(prev);
        if (peer) next.set(peerId, peer);
        else next.delete(peerId);
        return next;
      });
    });
    mesh.onMsg((msg) => {
      if (msg.type === 'sos') {
        setSosPeers((prev) => [...prev.slice(-9), msg]);
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          setRelayedCount((c) => c + 1);
        }
      }
    });

    void mesh.start(pos.lat, pos.lng);

    if (pendingSosRef.current) {
      mesh.sendSOS(pendingSosRef.current);
      pendingSosRef.current = null;
    }

    return () => {
      mesh.stop();
      meshRef.current = null;
    };
  }, [room]);

  useEffect(() => {
    if (position && meshRef.current) {
      meshRef.current.updatePosition(position.lat, position.lng, 10);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.lat, position?.lng]);

  const sendSOS = useCallback((sos?: Partial<SosBroadcastPayload['sos']>) => {
    if (!meshRef.current) {
      // Меш ещё не поднят — сигнал уйдёт сразу после старта
      pendingSosRef.current = sos ?? {};
      return null;
    }
    return meshRef.current.sendSOS(sos);
  }, []);

  return {
    status,
    peers,
    sosPeers,
    sendSOS,
    relayedCount,
    reconnecting: status === 'reconnecting',
    deviceId: meshRef.current?.deviceId,
  };
}
