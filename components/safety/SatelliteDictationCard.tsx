'use client';

import { useState, useCallback } from 'react';
import { CheckCircle, Copy, Satellite } from 'lucide-react';

interface Props {
  coords: { lat: number; lng: number } | null;
  touristName?: string;
  touristPhone?: string;
}

const SITUATION_TYPES = [
  { value: 'injury', label: 'Травма' },
  { value: 'medical', label: 'Медицина' },
  { value: 'lost', label: 'Потерялся' },
  { value: 'cold', label: 'Переохлаждение' },
  { value: 'stuck', label: 'Застряли' },
  { value: 'other', label: 'Другое' },
];

const SITUATION_LABELS: Record<string, string> = {
  injury: 'травма конечности',
  medical: 'медицинская помощь',
  lost: 'группа потерялась',
  cold: 'переохлаждение/обморожение',
  stuck: 'группа заблокирована',
  other: 'экстренная ситуация',
};

function buildCard(
  coords: { lat: number; lng: number } | null,
  situation: string,
  count: string,
  condition: string,
  phone: string,
): string {
  const coordStr = coords
    ? `${coords.lat.toFixed(5)}°N, ${coords.lng.toFixed(5)}°E`
    : 'координаты уточняются';

  const lines: string[] = [
    'МЧС, вызов. Нам нужна помощь.',
    `Координаты: ${coordStr}`,
    `Ситуация: ${SITUATION_LABELS[situation] ?? situation}.`,
    count ? `В группе ${count} чел.` : '',
    condition || '',
    phone ? `Обратный вызов: ${phone}` : '',
    'Ждём ответа.',
  ];

  return lines.filter(Boolean).join('\n');
}

export function SatelliteDictationCard({ coords, touristName, touristPhone }: Props) {
  const [situation, setSituation] = useState('injury');
  const [count, setCount] = useState('');
  const [condition, setCondition] = useState('');
  const [phone, setPhone] = useState(touristPhone ?? '');
  const [copied, setCopied] = useState(false);

  const cardText = buildCard(coords, situation, count, condition, phone);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(cardText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  }, [cardText]);

  return (
    <div style={{
      borderRadius: '14px',
      border: '1px solid rgba(147,112,219,0.3)',
      background: 'rgba(147,112,219,0.06)',
      overflow: 'hidden',
    }}>
      {/* Заголовок */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid rgba(147,112,219,0.2)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <Satellite size={15} style={{ color: '#a78bfa', flexShrink: 0 }} />
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>
          SOS через спутниковый телефон
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginLeft: 'auto' }}>
          Уровень 0
        </span>
      </div>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* Поля */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '8px' }}>
          {/* Тип ситуации */}
          <div>
            <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Ситуация
            </label>
            <select
              value={situation}
              onChange={e => setSituation(e.target.value)}
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: '13px',
                outline: 'none',
              }}
            >
              {SITUATION_TYPES.map(t => (
                <option key={t.value} value={t.value} style={{ background: '#1a1a1a' }}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Кол-во людей */}
          <div>
            <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Чел.
            </label>
            <input
              type="number"
              min={1}
              max={99}
              value={count}
              onChange={e => setCount(e.target.value)}
              placeholder="4"
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: '13px',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Уточнение */}
        <div>
          <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Уточнение (необязательно)
          </label>
          <input
            type="text"
            value={condition}
            onChange={e => setCondition(e.target.value)}
            placeholder="Переломаны лыжи, спуститься не можем"
            style={{
              width: '100%',
              padding: '7px 10px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        {/* Телефон обратного вызова */}
        <div>
          <label style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Обратный вызов
          </label>
          <input
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+7..."
            style={{
              width: '100%',
              padding: '7px 10px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        {/* Карточка диктовки */}
        <div style={{
          padding: '14px',
          borderRadius: '10px',
          background: 'rgba(0,0,0,0.35)',
          border: '1px solid rgba(147,112,219,0.25)',
        }}>
          <p style={{
            fontSize: '16px',
            fontWeight: 700,
            color: '#fff',
            lineHeight: 1.8,
            margin: 0,
            letterSpacing: '0.01em',
            whiteSpace: 'pre-line',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}>
            {cardText}
          </p>
        </div>

        {/* Копировать */}
        <button
          onClick={handleCopy}
          style={{
            width: '100%',
            padding: '11px',
            borderRadius: '10px',
            border: '1px solid rgba(147,112,219,0.4)',
            background: copied ? 'rgba(63,185,80,0.15)' : 'rgba(147,112,219,0.15)',
            color: copied ? '#3FB950' : '#a78bfa',
            fontWeight: 700,
            fontSize: '13px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '7px',
            transition: 'all 0.15s',
          }}
        >
          {copied ? <CheckCircle size={15} /> : <Copy size={15} />}
          {copied ? 'Скопировано' : 'Копировать карточку'}
        </button>

        <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', margin: 0, lineHeight: 1.5 }}>
          Работает без интернета. Прочитайте текст вслух дежурному МЧС по спутниковому телефону.
        </p>
      </div>
    </div>
  );
}
