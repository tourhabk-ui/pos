'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { getModelContext } from '@/lib/webmcp/page-tools';
import { readFormValues } from '@/lib/webmcp/form-sync';

/**
 * Перечитать поля формы после заполнения агентом WebMCP
 * (lib/webmcp/form-sync). Нет API в браузере — ничего не подписывается.
 */
export function useWebMcpFormSync<K extends string>(
  formRef: RefObject<HTMLFormElement | null>,
  names: readonly K[],
  onValues: (values: Partial<Record<K, string>>) => void,
): void {
  const onValuesRef = useRef(onValues);
  useEffect(() => {
    onValuesRef.current = onValues;
  }, [onValues]);
  const namesKey = names.join('|');
  useEffect(() => {
    const ctx = getModelContext();
    if (!ctx?.addEventListener) return;
    const fields = namesKey.split('|') as K[];
    const listener = () => {
      const form = formRef.current;
      if (!form) return;
      const values = readFormValues(form, fields);
      if (Object.keys(values).length > 0) onValuesRef.current(values);
    };
    ctx.addEventListener('toolactivated', listener);
    return () => ctx.removeEventListener?.('toolactivated', listener);
  }, [formRef, namesKey]);
}
