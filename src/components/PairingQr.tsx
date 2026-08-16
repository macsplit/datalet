import { useEffect, useMemo, useRef, useState } from "react";
import { encodePairingQr } from "../utils/qrCode";

export function PairingQr({ value }: { value: string }) {
  const qr = useMemo(() => encodePairingQr(value), [value]);
  const quietZone = 4;
  const size = qr.modules.length + quietZone * 2;
  const path = qr.modules.flatMap((row, y) =>
    row.flatMap((dark, x) => dark ? [`M${x + quietZone} ${y + quietZone}h1v1h-1z`] : []),
  ).join("");
  return (
    <svg
      className="pairing-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <title>Pairing QR code</title>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

type DetectedBarcode = { rawValue?: string };
type BarcodeDetectorInstance = { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> };
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorInstance;

function detectorConstructor(): BarcodeDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

export function PairingScanner({ onCode }: { onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  const available =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    detectorConstructor() !== undefined &&
    navigator.mediaDevices?.getUserMedia !== undefined;

  const releaseCamera = () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const stop = () => {
    releaseCamera();
    setScanning(false);
  };

  useEffect(() => () => releaseCamera(), []);

  const start = async () => {
    const Detector = detectorConstructor();
    if (!available || !Detector) return;
    setError(undefined);
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview could not start.");
      video.srcObject = stream;
      await video.play();
      const detector = new Detector({ formats: ["qr_code"] });
      const scanFrame = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const result = (await detector.detect(videoRef.current)).find((item) => item.rawValue);
          if (result?.rawValue) {
            onCode(result.rawValue);
            stop();
            return;
          }
        } catch {
          // A frame can be unavailable while the camera warms up; keep scanning.
        }
        frameRef.current = requestAnimationFrame(() => void scanFrame());
      };
      frameRef.current = requestAnimationFrame(() => void scanFrame());
    } catch (reason) {
      stop();
      setError(reason instanceof Error ? reason.message : "The camera could not be opened.");
    }
  };

  return (
    <div className="section-stack pairing-scanner">
      {available ? (
        <button type="button" className="secondary-btn" onClick={scanning ? stop : start}>
          {scanning ? "Stop scanning" : "Scan pairing QR"}
        </button>
      ) : (
        <p className="helper-text">
          QR scanning needs HTTPS or localhost and a browser with BarcodeDetector. Paste the pairing code instead.
        </p>
      )}
      <video
        ref={videoRef}
        className="pairing-video"
        hidden={!scanning}
        muted
        playsInline
        aria-label="Pairing QR camera preview"
      />
      {error && <p className="helper-text danger-text">Camera unavailable: {error}</p>}
    </div>
  );
}
