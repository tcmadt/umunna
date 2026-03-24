import { useState, useEffect } from 'react';
import type { PersonMap } from './types';

const ENDPOINT =
  'https://script.google.com/macros/s/AKfycbw7tNwm20dR-Wps69CuR9mb2mBPOAv3wVQwpiF8AqXmTbozdvKGLQv_miW6FC1FV55STQ/exec';

export function useSheetData(limit = 10) {
  const [people, setPeople] = useState<PersonMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cb = `__umunna_cb_${Date.now()}`;
    const script = document.createElement('script');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[cb] = (raw: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any)[cb];
      document.head.removeChild(script);

      // raw is keyed by string ID; filter to first `limit` numeric IDs
      const all = raw as Record<string, Record<string, unknown>>;
      // Start from ID 1 — ID 0 is isolated (parents outside loaded range)
      const ids = Object.keys(all)
        .map(Number)
        .filter(id => id >= 1)
        .sort((a, b) => a - b)
        .slice(0, limit);

      const result: PersonMap = {};
      ids.forEach(id => {
        const p = all[id];
        result[id] = {
          id,
          name: String(p.name ?? ''),
          g: String(p.g ?? 'm').startsWith('f') ? 'f' : 'm',
          pIds: (p.pIds as number[]) ?? [],
          sIds: (p.sIds as number[]) ?? [],
          nicks: (p.nicks as string[]) ?? [],
          notes: String(p.notes ?? ''),
          rel: String(p.rel ?? 'distant'),
          birthYear: String(p.birthYear ?? ''),
          deathYear: String(p.deathYear ?? ''),
          placeOfBirth: String(p.placeOfBirth ?? ''),
          currentLocation: String(p.currentLocation ?? ''),
          photoUrl: String(p.photoUrl ?? ''),
        };
      });

      // Filter pIds/sIds to only IDs we loaded
      const loaded = new Set(Object.keys(result).map(Number));
      Object.values(result).forEach(p => {
        p.pIds = p.pIds.filter(id => loaded.has(id));
        p.sIds = p.sIds.filter(id => loaded.has(id));
      });

      setPeople(result);
      setLoading(false);
    };

    script.src = `${ENDPOINT}?callback=${cb}&t=${Date.now()}`;
    script.onerror = () => {
      setError('Failed to load family data');
      setLoading(false);
    };
    document.head.appendChild(script);
  }, [limit]);

  return { people, loading, error };
}
