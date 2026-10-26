import { useEffect, useRef } from 'react';

/**
 * Scroll-reveal hook: adds .revealed to the element the first time it
 * enters the viewport. Uses classList (not state) so re-renders inside
 * the section (mock panel interactions) are unaffected.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) { el.classList.add('revealed'); return; }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { el.classList.add('revealed'); io.disconnect(); }
    }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}
