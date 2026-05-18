import { redirect } from 'next/navigation';

export default function PlacesPage() {
  redirect('/routes?kind=place');
}
