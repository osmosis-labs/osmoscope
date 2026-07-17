"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Matches bare or full URLs, plus *.osmosis.zone shorthands, so explainer text
// can embed links. Capturing group => odd split indices are the matched URLs.
const URL_RE =
  /(https?:\/\/[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.osmosis\.zone(?:\/[^\s]*)?)/gi;

function linkify(text: string): ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const href = part.startsWith("http") ? part : `https://${part}`;
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-osmo-pink underline hover:text-white"
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// A small `?` trigger that reveals an explainer popover on hover, keyboard focus,
// or click (click pins it open). Explainer text may contain links, which stay
// reachable by keyboard. Extracted from the treasury holder cards so the supply
// chart (and anything else) can reuse the same accessible behaviour.
export function InfoTooltip({
  text,
  ariaLabel = "More information",
  placement = "bottom",
  align = "center",
  onOpen,
}: {
  text: string;
  ariaLabel?: string;
  // Which side of the `?` the popover opens on. Default "bottom" (below the
  // trigger) matches the treasury cards. Use "top" when the trigger sits near the
  // bottom of its container (e.g. a chart's legend row), so the popover opens
  // UPWARD into the card rather than spilling past its bottom edge into whatever
  // is painted below.
  placement?: "top" | "bottom";
  // Horizontal anchor. "center" (default) centres the popover on the `?`. "end"
  // anchors its RIGHT edge to the `?` so it opens leftward/inward — use for a
  // trigger near the right edge of a scroll container (e.g. the last table
  // column's header) so the popover doesn't extend the container's scrollWidth
  // and spawn a horizontal scrollbar.
  align?: "center" | "end";
  // Reports effective open state up (e.g. so a parent card can lift its z-index
  // while the popover shows). Fired from an effect, after render.
  onOpen?: (open: boolean) => void;
}) {
  // Three independent inputs, because collapsing any two into one makes them
  // fight:
  //  - hovered: mouse is over the widget (open while true).
  //  - focused: keyboard/programmatic focus is within the widget (open while
  //    true) — this is what lets a keyboard user reach the tooltip's links.
  //  - pinned:  an explicit click toggled it open (survives losing hover/focus).
  // Only CLICK touches `pinned`. Focus must NOT set `pinned`, or a mouse click
  // would toggle it twice — once via the focus that a click delivers, once via
  // the click itself — and land back closed (defeating click-to-pin, worst on
  // touch where there's no lingering hover to keep it visible).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Escape sets this to suppress the popover even though focus is (briefly) still
  // on the trigger button after we return it there. Cleared on the next
  // mouse-enter, on focus landing anywhere other than the button (e.g. Tab into
  // a link), or on focus leaving the widget — so the tooltip is fully usable
  // again the moment the user does anything but hold Escape's dismissal.
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || focused || pinned);
  // The `?` trigger. Escape returns focus here so keyboard focus is never
  // stranded on a link inside the just-hidden popover.
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Report the effective open state up. useEffect so the parent update happens
  // after render, not during it.
  useEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);

  return (
    // Focus/blur live on the WRAPPER, not the button, and blur only closes when
    // focus leaves the whole widget (relatedTarget check) — so a keyboard user
    // can Tab from the `?` into the tooltip to reach its links without it closing.
    // Escape closes it.
    <span
      className="relative inline-flex shrink-0"
      // Interactive-only explainer: dropped from screenshot exports (a `?`
      // trigger reads oddly as a static image, and its popover never shows).
      data-screenshot-hide
      onMouseEnter={() => {
        setDismissed(false);
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => {
        setFocused(true);
        // Clear an Escape dismissal unless focus is on the `?` trigger itself.
        // Escape hides the popover and returns focus to the button, so we must
        // NOT un-dismiss for that button-refocus (it would immediately re-show).
        // But focus landing on ANY other element in the widget — e.g. the user
        // Tabbing from the button forward into a tooltip link — is genuine intent
        // to interact, so re-show.
        if (e.target !== buttonRef.current) setDismissed(false);
      }}
      onBlur={(e) => {
        // Only close on focus LEAVING the whole widget (relatedTarget check), so
        // a keyboard user can Tab from the `?` into the tooltip to reach its
        // links without it closing. Focus leaving also lifts an Escape dismissal,
        // so a later Tab back in re-opens normally.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
          setDismissed(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Hide the popover and return focus to the `?` trigger. If a tooltip
          // link had focus, closing without moving focus would strand it on a
          // now-hidden element. Returning focus keeps it on real, visible UI;
          // `dismissed` keeps the popover hidden despite that focus.
          setPinned(false);
          setHovered(false);
          setDismissed(true);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          // Toggle the pin. When unpinning, also drop `focused` — the click
          // itself keeps the button focused, so without this the popover would
          // stay open (focused===true) and the second click would appear inert.
          setDismissed(false);
          setPinned((v) => {
            if (v) setFocused(false);
            return !v;
          });
        }}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-white/30 text-[10px] font-bold leading-none text-osmo-200 transition-colors hover:bg-white/20 hover:text-white"
      >
        ?
      </button>
      {/* Pointer-events enabled only when open, so links inside are clickable and
          focusable; the wrapper's focus containment keeps it open while a link
          inside has focus. */}
      <span
        role="tooltip"
        className={`absolute z-20 w-64 rounded-lg border border-white/20 bg-osmo-900 p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-osmo-100 shadow-xl transition-opacity duration-150 ${
          align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"
        } ${placement === "top" ? "bottom-6" : "top-6"} ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {linkify(text)}
      </span>
    </span>
  );
}
