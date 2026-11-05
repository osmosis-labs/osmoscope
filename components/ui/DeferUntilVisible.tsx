"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Mounts its children only once the placeholder comes within `margin` of the
// viewport, then keeps them mounted. Long pages draw every chart at once
// otherwise, which on phones is most of the load-time main-thread work. The
// placeholder reserves roughly the section's height so the page doesn't jump when the section
// appears; it mounts well before it scrolls into view.
export function DeferUntilVisible({
  enabled = true,
  placeholderClassName,
  margin = "800px",
  children,
}: {
  // Start watching only once true: while the content above is still loading,
  // the page is short and every placeholder would count as near the viewport.
  enabled?: boolean;
  placeholderClassName: string; // min-height classes for the placeholder
  margin?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible || !enabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${margin} 0px` }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, enabled, margin]);

  if (visible) return <>{children}</>;
  return <div ref={ref} className={placeholderClassName} aria-hidden />;
}
