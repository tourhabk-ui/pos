/** Кнопки «Занять/Освободить места» — без базы (экраны кабинета). */

import { signPayload } from '@/lib/chat-cabinet/signed-payload';

export function holdButtons(requestId: string, held: boolean): Array<{ text: string; payload: string }> {
  const id = requestId.toLowerCase();
  return held
    ? [{ text: 'Освободить места', payload: signPayload(`sh:r:${id}`) }]
    : [{ text: 'Занять места', payload: signPayload(`sh:h:${id}`) }];
}
