'use client';

import { Radio, WifiOff, Loader2, Users, Share2 } from 'lucide-react';
import type { MeshStatus, MeshPeer } from '@/lib/mesh/types';

interface Props {
  status: MeshStatus;
  peers: Map<string, MeshPeer>;
  relayedCount: number;
}

function timeAgo(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min === 1) return '1 мин назад';
  return `${min} мин назад`;
}

export function MeshStatusWidget({ status, peers, relayedCount }: Props) {
  if (status === 'idle') return null;

  const activePeers = Array.from(peers.values()).filter(
    (p) => Date.now() - p.lastSeen < 5 * 60 * 1000
  );
  const peerCount = activePeers.length;

  const isConnecting = status === 'connecting' || status === 'reconnecting';
  const isConnected = status === 'connected';
  const hasRelay = isConnected && peerCount > 0;

  const borderColor = hasRelay
    ? 'rgba(63,185,80,0.35)'
    : isConnected
    ? 'rgba(37,104,176,0.35)'
    : isConnecting
    ? 'rgba(210,153,34,0.35)'
    : 'rgba(255,255,255,0.1)';

  // Статусные цвета — DS-токены (§2); белые с альфой ниже — glass поверх тёмного, допустимо.
  const dotColor = hasRelay
    ? 'var(--success)'
    : isConnected
    ? 'var(--ocean)'
    : isConnecting
    ? 'var(--warning)'
    : 'var(--text-muted)';

  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: '12px',
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${borderColor}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
            ...(isConnecting ? { animation: 'kh-mesh-pulse 1.2s ease-in-out infinite' } : {}),
          }}
        />
        {isConnecting && (
          <Loader2 size={13} style={{ color: 'var(--warning)', animation: 'kh-spin 1s linear infinite', flexShrink: 0 }} />
        )}
        {!isConnecting && hasRelay && (
          <Radio size={13} style={{ color: 'var(--success)', flexShrink: 0 }} />
        )}
        {!isConnecting && !hasRelay && isConnected && (
          <WifiOff size={13} style={{ color: 'var(--ocean)', flexShrink: 0 }} />
        )}
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#fff', flex: 1 }}>
          {isConnecting && (status === 'reconnecting' ? 'Меш переподключается...' : 'Меш подключается...')}
          {isConnected && peerCount > 0 && `${peerCount} ${peerCount === 1 ? 'устройство' : peerCount < 5 ? 'устройства' : 'устройств'} рядом`}
          {isConnected && peerCount === 0 && 'Меш пуст'}
          {status === 'error' && 'Меш недоступен'}
        </span>
      </div>

      <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', margin: 0, lineHeight: 1.5 }}>
        {hasRelay && 'SOS ретранслируется через группу — даже без прямого интернета.'}
        {isConnected && peerCount === 0 && 'Нет других устройств в радиусе. SOS идёт напрямую.'}
        {isConnecting && 'Ждём подключения к меш-сети...'}
        {status === 'error' && 'SOS отправляется стандартным способом.'}
      </p>

      {(peerCount > 0 || relayedCount > 0) && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {peerCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Users size={11} style={{ color: 'rgba(255,255,255,0.3)' }} />
              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)' }}>
                {activePeers
                  .slice(0, 3)
                  .map((p) => `·${timeAgo(p.lastSeen)}`)
                  .join(' ')}
              </span>
            </div>
          )}
          {relayedCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Share2 size={11} style={{ color: 'rgba(63,185,80,0.6)' }} />
              <span style={{ fontSize: '10px', color: 'rgba(63,185,80,0.6)' }}>
                Ретранслировано SOS: {relayedCount}
              </span>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes kh-mesh-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes kh-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
