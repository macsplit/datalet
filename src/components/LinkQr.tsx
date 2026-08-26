import { useMemo } from "react";
import { encodeLinkQr, type QrCode } from "../utils/qrCode";
import { QrImage } from "./QrImage";

/**
 * A QR code for an actual https:// invite link, as opposed to `PairingQr`'s
 * QR of a bare pairing code. A phone's own camera app recognizes a link QR
 * and offers to open it directly - the reason this exists at all: a bare
 * code decodes to plain text with nowhere obvious to go, which on at least
 * some Android camera apps lands straight in a search box instead. See
 * docs/roadmap.md's write-up of this decision for the fuller reasoning.
 */
function tryEncode(url: string): QrCode | undefined {
  try {
    return encodeLinkQr(url);
  } catch {
    return undefined;
  }
}

export function LinkQr({ url, label }: { url: string; label: string }) {
  const qr = useMemo(() => tryEncode(url), [url]);
  return <QrImage qr={qr} label={label} className="pairing-qr" />;
}
