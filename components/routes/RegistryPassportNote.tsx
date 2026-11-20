/**
 * Строка карточки маршрута о паспорте реестра, который к ней не привязан
 * (#3568, слово владельца 20.11 «2 дописать»): что в паспорте и что маршрут
 * там может отличаться, со ссылкой на сам PDF. Правило слов —
 * `lib/routes/registry-passport`.
 */
import { FileText } from 'lucide-react';
import {
  registryPassportLinkLabel,
  registryPassportNote,
  type RegistryPassportRef,
} from '@/lib/routes/registry-passport';

export default function RegistryPassportNote({ refs }: { refs: RegistryPassportRef[] }) {
  const note = registryPassportNote(refs);
  if (!note) return null;
  return (
    <div
      className="flex gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]"
      data-testid="registry-passport-note"
    >
      <FileText className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--ocean)]" aria-hidden />
      <div className="text-sm text-[var(--text-secondary)] leading-snug">
        <p>{note}</p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {refs.map((r) => (
            <a
              key={r.url}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ocean)] underline underline-offset-2"
            >
              {registryPassportLinkLabel(r)}
            </a>
          ))}
        </p>
      </div>
    </div>
  );
}
