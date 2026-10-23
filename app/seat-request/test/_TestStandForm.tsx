'use client';

import { useState } from 'react';
import { SeatRequestForm } from '@/components/planner/SeatRequestForm';

export function TestStandForm({ tour, seasonWindow }: {
  tour: { id: string; title: string };
  seasonWindow: { from: string; to: string } | null;
}) {
  const [open, setOpen] = useState(true);
  if (!open) {
    return <button type="button" className="rounded border px-4 py-2" onClick={() => setOpen(true)}>Ещё один запрос</button>;
  }
  return (
    <SeatRequestForm
      tour={tour}
      defaultDate=""
      defaultParticipants={1}
      seasonWindow={seasonWindow}
      onClose={() => setOpen(false)}
      source="tour_card"
    />
  );
}
