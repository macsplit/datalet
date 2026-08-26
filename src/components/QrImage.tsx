import type { QrCode } from "../utils/qrCode";

/**
 * Renders an already-encoded QR matrix as an SVG, or a fallback message if
 * there wasn't one to render. Shared by `PairingQr` and `LinkQr` - drawing a
 * matrix of dark/light modules doesn't care what was encoded into it, only
 * `qrCode.ts` does.
 */
export function QrImage({ qr, label, className }: { qr: QrCode | undefined; label: string; className: string }) {
  if (!qr) {
    return <p className="helper-text">QR code unavailable - use the text or link above instead.</p>;
  }
  const quietZone = 4;
  const size = qr.modules.length + quietZone * 2;
  const path = qr.modules.flatMap((row, y) =>
    row.flatMap((dark, x) => dark ? [`M${x + quietZone} ${y + quietZone}h1v1h-1z`] : []),
  ).join("");
  return (
    <svg
      className={className}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <title>{label}</title>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
