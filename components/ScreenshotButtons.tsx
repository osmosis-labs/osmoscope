"use client";

import { useCallback, useState } from "react";
// html2canvas (~large) is only needed when the user actually captures a
// screenshot, so it's dynamically imported inside the capture handler rather
// than statically — keeping it out of the initial page bundle.

interface ScreenshotButtonsProps {
  // Nullable to match what useRef<HTMLElement>(null) actually produces under
  // current React types; guarded with `targetRef.current` before use.
  targetRef: React.RefObject<HTMLElement | null>;
  filename: string;
}

export function ScreenshotButtons({
  targetRef,
  filename,
}: ScreenshotButtonsProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [showCopiedFeedback, setShowCopiedFeedback] = useState(false);

  const captureScreenshot = useCallback(async () => {
    if (!targetRef.current) {
      return null;
    }

    try {
      setIsCapturing(true);

      // No need to manipulate the original DOM - we'll do it all in onclone

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

      // Load html2canvas on demand (kept out of the initial bundle).
      const html2canvas = (await import("html2canvas")).default;

      // Capture the element as canvas with onclone callback
      const originalCanvas = await html2canvas(targetRef.current, {
        backgroundColor: "#1f0a29",
        scale: 2, // Higher quality
        logging: false,
        useCORS: true, // Enable cross-origin images
        allowTaint: true, // Allow tainted canvas
        onclone: (clonedDoc) => {
          // Hide screenshot buttons in the cloned document
          const clonedButtons = clonedDoc.querySelectorAll(
            "[data-screenshot-hide]"
          );
          clonedButtons.forEach((btn) => {
            (btn as HTMLElement).style.display = "none";
          });

          // Hide time range selectors in the cloned document
          const clonedSelectors = clonedDoc.querySelectorAll(
            "[data-screenshot-compact]"
          );
          clonedSelectors.forEach((selector) => {
            (selector as HTMLElement).style.display = "none";
          });

          // Force font-family and proper rendering on all text elements in clone
          const allElements = clonedDoc.body.getElementsByTagName("*");
          for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i] as HTMLElement;
            const computedStyle = window.getComputedStyle(el);

            // Fix headline statistics specifically (large bold text)
            const fontSize = parseFloat(computedStyle.fontSize);
            if (fontSize >= 24) {
              // Headline text
              el.style.fontFamily =
                "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
              el.style.fontStretch = "100%";
              el.style.letterSpacing = "0";
              el.style.wordSpacing = "0.25em"; // Add explicit word spacing
              el.style.whiteSpace = "pre"; // Preserve all whitespace
              el.style.textRendering = "geometricPrecision";
            } else if (computedStyle.fontFamily.includes("Inter")) {
              el.style.fontFamily =
                "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
            }
          }
        },
      });

      // Create a NEW canvas and copy the html2canvas result to it
      // This allows us to modify it (html2canvas canvas might be readonly)
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

                // Position at top center with some margin
                const x = (canvas.width - watermarkWidth) / 2;
                const y = canvas.height * 0.05; // 5% from top

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

      // No need to restore anything - we never touched the original DOM
      return canvas;
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
      return null;
    } finally {
      setIsCapturing(false);
    }
  }, [targetRef]);

  const handleSave = useCallback(async () => {
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

    // Convert to blob using promise
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png", 1.0);
    });

    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().split("T")[0]}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [captureScreenshot, filename]);

  const handleShare = useCallback(async () => {
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

    // Try to use Web Share API
    if (navigator.share) {
      try {
        const file = new File(
          [blob],
          `${filename}-${new Date().toISOString().split("T")[0]}.png`,
          {
            type: "image/png",
          }
        );

        await navigator.share({
          files: [file],
          title: "Osmosis Metrics",
          text: "Check out these Osmosis metrics!",
        });
      } catch (error) {
        // User cancelled or share failed
        console.log("Share cancelled or failed:", error);
      }
    } else {
      // Fallback: download the image
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${filename}-${new Date().toISOString().split("T")[0]}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }, [captureScreenshot, filename]);

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
      className="relative flex w-fit shrink-0 gap-1 self-start rounded-lg bg-white/5 p-1"
      data-screenshot-hide
    >
      {/* Copied feedback */}
      {showCopiedFeedback && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-osmo-purple px-3 py-1 text-xs font-medium text-white shadow-lg">
          Copied to clipboard!
        </div>
      )}

      {/* Save Image Button */}
      <button
        onClick={handleSave}
        disabled={isCapturing}
        className="rounded px-2 py-1 transition-colors hover:bg-white/10 disabled:opacity-50"
        title="Save as image"
        aria-label="Save as image"
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
          {/* Camera icon */}
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>

      {/* Share Button (Web Share API) */}
      <button
        onClick={handleShare}
        disabled={isCapturing}
        className="rounded px-2 py-1 transition-colors hover:bg-white/10 disabled:opacity-50"
        title="Share image"
        aria-label="Share image"
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
          {/* Share icon */}
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
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
    </div>
  );
}
