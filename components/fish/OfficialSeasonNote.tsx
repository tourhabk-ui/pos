import { SALMON_OFFICIAL_SEASON } from '@/lib/fish/fish-sources';

/** Официальные сроки лова лососей рядом со сроками хода (Сыщик 21.11). */
export function OfficialSeasonNote() {
  const s = SALMON_OFFICIAL_SEASON;
  return (
    <p data-official-season className="text-sm text-[var(--text-secondary)] mt-3 rounded-lg p-3" style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.03))' }}>
      {s.text}{' '}
      <span className="text-[var(--text-muted)]">
        Источники:{' '}
        {s.sources.map((src, i) => (
          <span key={src.url}>
            {i > 0 && '; '}
            <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline">{src.title}</a>
          </span>
        ))}.
      </span>
    </p>
  );
}
