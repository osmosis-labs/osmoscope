"use client";

import { useCallback, useRef, useState } from "react";
import { downloadCsv, type CsvRow } from "@/lib/csv";
// The screenshot rasterizer (modern-screenshot) is only needed when the user
// actually captures, so it's dynamically imported inside the capture handler
// rather than statically, keeping it out of the initial page bundle.

interface ScreenshotButtonsProps {
  // Nullable to match what useRef<HTMLElement>(null) actually produces under
  // current React types; guarded with `targetRef.current` before use.
  targetRef: React.RefObject<HTMLElement | null>;
  filename: string;
  /**
   * Context-aware caption prefilled into the X composer for THIS chart (e.g.
   * "OSMO supply distribution on Osmosis"). Falls back to a generic line.
   */
  shareText?: string;
  /**
   * Full-history rows for CSV export, built lazily on click. When provided, a
   * CSV icon-button appears inside this cluster next to X / copy. Omit for
   * single-datapoint sections (e.g. the burn doughnut), where no button shows.
   */
  csvRows?: () => CsvRow[];
  /** CSV download filename (no extension). Defaults to `filename`. */
  csvFilename?: string;
}

// Generic fallback caption when a chart doesn't pass its own shareText.
const DEFAULT_SHARE_TEXT = "Osmosis metrics via OSMOscope";
// Suffix appended to every share caption so posts are attributed + discoverable.
const SHARE_SUFFIX = "via OSMOscope";

export function ScreenshotButtons({
  targetRef,
  filename,
  shareText,
  csvRows,
  csvFilename,
}: ScreenshotButtonsProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  // Synchronous re-entry lock. The buttons are disabled while capturing, but a
  // ref guarantees no two captures ever run concurrently (state updates are
  // async): overlapping runs would each mutate + restore the same live-DOM
  // inline styles in interleaved finally blocks and corrupt them.
  const capturingRef = useRef(false);
  const [showCopiedFeedback, setShowCopiedFeedback] = useState(false);
  // X-share toast: holds the composer URL + whether the chart actually made it
  // to the clipboard. The user clicks the link to open the composer (a fresh
  // gesture, so it's never popup-blocked); the copy happened earlier while the
  // page was focused (a single click can't both copy AND open a tab, since
  // opening steals the focus clipboard.write requires). `copied` drives the
  // toast wording so we don't tell the user to paste an image that never landed
  // on the clipboard. null = hidden.
  const [shareToast, setShareToast] = useState<{
    url: string;
    copied: boolean;
  } | null>(null);
  // Brief "no data" toast if a CSV export is triggered with an empty series.
  const [showNoDataFeedback, setShowNoDataFeedback] = useState(false);

  const handleCsvExport = useCallback(() => {
    if (!csvRows) return;
    try {
      const ok = downloadCsv(csvFilename ?? filename, csvRows());
      if (!ok) {
        setShowNoDataFeedback(true);
        setTimeout(() => setShowNoDataFeedback(false), 2000);
      }
    } catch (e) {
      console.error("Failed to export CSV:", e);
      setShowNoDataFeedback(true);
      setTimeout(() => setShowNoDataFeedback(false), 2000);
    }
  }, [csvRows, csvFilename, filename]);

  const captureScreenshot = useCallback(async () => {
    if (!targetRef.current) {
      return null;
    }
    // Refuse to start if a capture is already running (see capturingRef).
    if (capturingRef.current) {
      return null;
    }

    try {
      capturingRef.current = true;
      setIsCapturing(true);

      // Comprehensive font loading - wait for all fonts to be ready
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      // Force load all Inter font weights and sizes that might be used
      const fontSizes = [
        "10px",
        "12px",
        "14px",
        "16px",
        "18px",
        "20px",
        "24px",
        "32px",
      ];
      const fontWeights = ["400", "500", "600", "700"];

      try {
        const fontPromises = [];
        for (const weight of fontWeights) {
          for (const size of fontSizes) {
            fontPromises.push(document.fonts.load(`${weight} ${size} Inter`));
          }
        }
        await Promise.all(fontPromises);
      } catch (e) {
        // Font loading may fail, continue anyway
      }

      // Additional wait for rendering to settle and fonts to be applied
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Render via modern-screenshot (loaded on demand to keep it out of the
      // initial bundle). Unlike html2canvas, it rasterizes through the browser's
      // own engine (SVG foreignObject), so text position/metrics match the live
      // DOM exactly — that fixes the legend numbers sinking below their names and
      // the clipped title that no amount of html2canvas onclone CSS could correct.
      // Because text is faithful, none of the old per-element line-height /
      // tabular-nums / baseline workarounds are needed.
      const { domToCanvas } = await import("modern-screenshot");

      // Reveal screenshot-only elements on the LIVE DOM before capture, not in a
      // clone hook. modern-screenshot bakes each node's style from the ORIGINAL
      // element during cloning (before onCloneEachNode runs), so a display:none
      // set live can't be overridden on the clone afterward. So we flip them here
      // and restore in `finally`. The flip is synchronous and immediately
      // followed by the capture, so it isn't visible to the user.
      const revealed: { el: HTMLElement; cssText: string }[] = [];
      const reveal = (el: HTMLElement, display: string) => {
        revealed.push({ el, cssText: el.style.cssText });
        el.style.setProperty("display", display, "important");
      };
      const root = targetRef.current;
      root
        .querySelectorAll<HTMLElement>("[data-screenshot-only]")
        .forEach((el) => reveal(el, "flex"));
      root
        .querySelectorAll<HTMLElement>("[data-screenshot-only-inline]")
        .forEach((el) => {
          reveal(el, "inline");
          // The inline suffix sits inside a `truncate` <h2> (overflow:hidden +
          // nowrap) that would clip the appended text; un-clip its ancestors.
          let p = el.parentElement;
          while (p && p !== root.parentElement) {
            revealed.push({ el: p, cssText: p.style.cssText });
            p.style.setProperty("overflow", "visible", "important");
            p.style.setProperty("text-overflow", "clip", "important");
            p.style.setProperty("white-space", "normal", "important");
            p = p.parentElement;
          }
        });
      // Scroll containers (e.g. a wide table's overflow-x-auto wrapper) render
      // their scrollbar into the capture and can clip content. Force overflow
      // visible on tagged containers so the full content is captured cleanly.
      root
        .querySelectorAll<HTMLElement>("[data-screenshot-overflow-visible]")
        .forEach((el) => {
          revealed.push({ el, cssText: el.style.cssText });
          el.style.setProperty("overflow", "visible", "important");
        });
      // Card titles must never wrap in the export. The rasterizer's font
      // metrics can differ from the live render by a fraction of a pixel, and
      // each element's box is pixel-locked from its live computed style, so a
      // heading that overflows its baked width by even 1px wraps its last word
      // onto a second line (environment-dependent: "OSMO Inflation" split for
      // some users while identical captures elsewhere stayed on one line).
      // Runs AFTER the inline-suffix un-clipping above so this nowrap wins on
      // a title both passes touch (restore is reverse-order, so both undo
      // cleanly).
      root.querySelectorAll<HTMLElement>("h2, h3").forEach((el) => {
        revealed.push({ el, cssText: el.style.cssText });
        el.style.setProperty("white-space", "nowrap", "important");
      });

      let originalCanvas: HTMLCanvasElement;
      try {
        originalCanvas = await domToCanvas(root, {
          backgroundColor: "#1f0a29",
          scale: 2, // Higher quality
          // Drop interactive-only controls (share pill, time-range selector).
          // `filter` returns false to exclude a node and its subtree.
          filter: (node) => {
            if (node instanceof HTMLElement) {
              if (
                node.hasAttribute("data-screenshot-hide") ||
                node.hasAttribute("data-screenshot-compact")
              ) {
                return false;
              }
            }
            return true;
          },
        });
      } finally {
        // Restore every element we touched to its exact prior inline style,
        // in REVERSE order: an element mutated by two passes (e.g. a treasury
        // title hit by both the inline-suffix un-clip and the heading nowrap)
        // has two snapshots, and only last-in-first-out replay lands it back
        // on the original.
        for (let i = revealed.length - 1; i >= 0; i--) {
          revealed[i].el.style.cssText = revealed[i].cssText;
        }
      }

      // Copy into a fresh canvas we own, so we can composite the watermark onto
      // it (the rasterizer's canvas may be read-only).
      const canvas = document.createElement("canvas");
      canvas.width = originalCanvas.width;
      canvas.height = originalCanvas.height;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return originalCanvas;
      }

      // Copy the original canvas to the new one
      ctx.drawImage(originalCanvas, 0, 0);

      // Add watermark across entire background (skip for burned percentage chart)
      if (filename !== "osmo-burned-percentage") {
        try {
          // Load watermark SVG
          const watermarkResponse = await fetch("/Osmosis_Brandmark.svg");

          if (!watermarkResponse.ok) {
            throw new Error(
              `Failed to fetch watermark: ${watermarkResponse.status}`
            );
          }

          const watermarkSvg = await watermarkResponse.text();

          // Convert SVG to data URL
          const img = new Image();
          img.crossOrigin = "anonymous";

          // Create data URL from SVG
          const svgDataUrl =
            "data:image/svg+xml;base64," +
            btoa(unescape(encodeURIComponent(watermarkSvg)));

          await new Promise<void>((resolve, reject) => {
            img.onload = () => {
              try {
                // Scale watermark to 12.5% of canvas width for small top watermark
                const watermarkWidth = Math.floor(canvas.width * 0.125);
                const watermarkHeight = Math.floor(watermarkWidth * (60 / 223)); // Original SVG aspect ratio

                // Position at top center. Use a small margin tied to the
                // watermark's OWN height (not a % of the card height, which sat
                // too low on short cards and overlapped the title).
                const x = (canvas.width - watermarkWidth) / 2;
                const y = Math.floor(watermarkHeight * 0.4);

                // Draw the watermark with 80% opacity
                ctx.globalAlpha = 0.8;
                ctx.drawImage(img, x, y, watermarkWidth, watermarkHeight);
                ctx.globalAlpha = 1.0;

                resolve();
              } catch (err) {
                console.error("Error drawing watermark:", err);
                resolve(); // Continue even if watermark fails
              }
            };
            img.onerror = (err) => {
              console.error("Error loading watermark image:", err);
              resolve(); // Continue even if watermark fails
            };
            img.src = svgDataUrl;
          });
        } catch (error) {
          console.error("Error loading watermark:", error);
          // Continue even if watermark fails
        }
      }

      // Live-DOM reveals were already restored in the capture's own finally.
      return canvas;
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
      return null;
    } finally {
      capturingRef.current = false;
      setIsCapturing(false);
    }
  }, [targetRef]);

  // Share to X. The X intent URL can only carry text + a link (it can't upload
  // a locally-generated image), and the link's rich preview is the generic
  // OSMOscope OG card, not this specific chart. So to share the ACTUAL chart we
  // copy its PNG to the clipboard first, then open the X composer prefilled with
  // the text + page link; the user pastes the chart image (Ctrl+V) into the
  // post. This replaced the old Web Share API button, which on desktop only
  // surfaced the OS share sheet (rarely containing X).
  const handleShare = useCallback(async () => {
    // A single click can't reliably BOTH copy the chart AND open the X tab:
    // clipboard.write needs the page focused, but opening a tab steals focus,
    // and the ~1s capture is too slow to open a tab after it without the popup
    // being blocked. So we do the reliable half here — capture the chart and
    // copy it to the clipboard while the page is still focused — then surface a
    // toast with an "Open X composer" link. The user's click on that link is a
    // fresh gesture, so the composer opens unblocked, and the chart is already
    // on their clipboard to paste (Ctrl/Cmd+V).
    const canvas = await captureScreenshot();
    if (!canvas) return;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png", 1.0);
    });

    // Track whether the chart actually reached the clipboard, so the toast only
    // tells the user to paste when there's really something to paste.
    let copied = false;
    if (blob) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        copied = true;
      } catch (error) {
        console.error("Failed to copy chart to clipboard for share:", error);
      }
    }

    // Context-aware caption for this specific chart, always attributed.
    const caption = shareText
      ? `${shareText} ${SHARE_SUFFIX}`
      : DEFAULT_SHARE_TEXT;
    const pageUrl = window.location.href;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      caption
    )}&url=${encodeURIComponent(pageUrl)}`;
    setShareToast({ url: intent, copied });
  }, [captureScreenshot, shareText]);

  const handleCopyToClipboard = useCallback(async () => {
    const canvas = await captureScreenshot();
    if (!canvas) return;

    // Force a reflow to ensure canvas is fully rendered
    canvas.offsetHeight;

    // Wait for any pending canvas operations
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      })
    );

    // Convert to blob
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png", 1.0);
    });

    if (!blob) return;

    // Try to copy to clipboard
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": blob,
        }),
      ]);

      // Show success feedback
      setShowCopiedFeedback(true);
      setTimeout(() => {
        setShowCopiedFeedback(false);
      }, 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      // Note: Use the save button if clipboard access is not available
    }
  }, [captureScreenshot, filename]);

  return (
    <div
      className="relative flex w-fit shrink-0 gap-1 rounded-lg bg-white/5 p-1"
      data-screenshot-hide
    >
      {/* Copied feedback */}
      {showCopiedFeedback && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-osmo-purple px-3 py-1 text-xs font-medium text-white shadow-lg">
          Copied to clipboard!
        </div>
      )}

      {/* CSV empty-series feedback */}
      {showNoDataFeedback && (
        <div className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-red-500/90 px-3 py-1 text-xs font-medium text-white shadow-lg">
          No data to export
        </div>
      )}

      {/* Share-to-X: the user clicks this link to open the composer (a fresh
          gesture, so it isn't popup-blocked). The message reflects whether the
          chart actually reached the clipboard — we don't promise a paste that
          isn't there. Dismisses on click or via the close button. */}
      {shareToast && (
        <div className="absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded bg-osmo-purple px-3 py-1.5 text-xs font-medium text-white shadow-lg">
          <span>
            {shareToast.copied ? "Chart copied." : "Couldn’t copy chart."}
          </span>
          <a
            href={shareToast.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setShareToast(null)}
            className="inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 font-semibold underline-offset-2 hover:bg-white/30 hover:underline"
          >
            Open X composer
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
          </a>
          <button
            type="button"
            onClick={() => setShareToast(null)}
            aria-label="Dismiss"
            className="ml-0.5 text-white/70 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Share to X: copies the chart to the clipboard and opens the X composer
          prefilled with the page link (which carries the OG preview). */}
      <button
        onClick={handleShare}
        disabled={isCapturing}
        className="rounded px-2 py-1 transition-colors hover:bg-white/10 disabled:opacity-50"
        title="Share to X (copies chart to clipboard to paste)"
        aria-label="Share to X"
      >
        {/* X (formerly Twitter) logo */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-osmo-100"
          aria-hidden="true"
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </svg>
      </button>

      {/* Copy to Clipboard Button */}
      <button
        onClick={handleCopyToClipboard}
        disabled={isCapturing}
        className="rounded px-2 py-1 transition-colors hover:bg-white/10 disabled:opacity-50"
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-osmo-100"
        >
          {/* Clipboard/Copy icon */}
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>

      {/* Export CSV: only rendered when the chart supplies a data series (single-
          datapoint sections omit it). Icon-only, matching the sibling buttons. */}
      {csvRows && (
        <button
          type="button"
          onClick={handleCsvExport}
          className="rounded px-2 py-1 transition-colors hover:bg-white/10"
          title="Export this chart's full data as CSV"
          aria-label="Export data as CSV"
        >
          {/* Download-to-tray icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-osmo-100"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      )}
    </div>
  );
}
