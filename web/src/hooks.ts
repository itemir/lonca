import { useEffect, useRef, useState } from 'react';

/** A narrow screen, which has room for one thing at a time. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 720px)');
    const update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

/** A screen without a mouse, and so usually with an on-screen keyboard. */
export const isTouch = () => matchMedia('(pointer: coarse)').matches;

/** Calls `load` now and on an interval while the page is visible, keeping the latest result. */
export function usePolled<T>(load: (() => Promise<T>) | null, intervalMs: number, deps: unknown[]): {
  data: T | null;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(load);
  latest.current = load;
  const generation = useRef(0);
  const inFlight = useRef(false);

  const refresh = () => {
    const current = latest.current;
    // A slow workspace shouldn't collect a pile of the same request.
    if (!current || inFlight.current) return;
    inFlight.current = true;
    const id = ++generation.current;
    current().then(
      (value) => {
        if (id === generation.current) {
          inFlight.current = false;
          setData(value);
          setError(null);
        }
      },
      (failure: Error) => {
        if (id === generation.current) {
          inFlight.current = false;
          setError(failure.message);
        }
      },
    );
  };

  useEffect(() => {
    setData(null);
    setError(null);
    inFlight.current = false;
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}

export function useOutsideClick(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOutside();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
    };
  }, [ref, onOutside, active]);
}

/** A panel size that the user can drag, remembered between visits. */
export function useResizable(key: string, initial: number, min: number, max: number, axis: 'x' | 'y', invert: boolean) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`lonca.size.${key}`));
    return saved >= min && saved <= max ? saved : initial;
  });

  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const startSize = size;
    let latest = startSize;
    const move = (moved: PointerEvent) => {
      const position = axis === 'x' ? moved.clientX : moved.clientY;
      const delta = invert ? start - position : position - start;
      latest = Math.min(max, Math.max(min, startSize + delta));
      setSize(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      localStorage.setItem(`lonca.size.${key}`, String(latest));
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return { size, onPointerDown };
}
