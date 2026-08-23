import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * Landing page for shareable invite links.
 * URL: /join?token=<UUID>
 *
 * Flow:
 * 1. Extract token from URL
 * 2. POST to /api/invite-redeem to get the code
 * 3. Show confirmation dialog with vault metadata
 * 4. On confirm, process the code (add datalet or pair vault)
 */

export function JoinPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/join" });
  const token = (search as { token?: string }).token;

  const [state, setState] = useState<"loading" | "error" | "confirm">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [codeType, setCodeType] = useState<"COPY" | "PAIR">();
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!token) {
      setErrorMsg("No invite token provided");
      setState("error");
      return;
    }

    const redeem = async () => {
      try {
        // Try COPY first, then PAIR
        for (const type of ["COPY", "PAIR"] as const) {
          const res = await fetch("/sync/invite-redeem", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ codeType: type, inviteToken: token }),
          });
          if (res.ok) {
            const data = (await res.json()) as { code: string };
            setCodeType(type);
            setCode(data.code);
            setState("confirm");
            return;
          }
          if (res.status === 404) continue; // Try next type
          throw new Error(`${res.status}: ${await res.text()}`);
        }
        // Neither type worked
        setErrorMsg("This invite link has expired or was already used");
        setState("error");
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : "Failed to redeem invite");
        setState("error");
      }
    };

    redeem();
  }, [token]);

  if (state === "loading") {
    return <div className="page"><p>Redeeming invite link…</p></div>;
  }

  if (state === "error") {
    return (
      <div className="page" style={{ textAlign: "center", padding: "2rem" }}>
        <h2>Invite Link Invalid</h2>
        <p>{errorMsg}</p>
        <button
          type="button"
          className="primary-btn"
          onClick={() => navigate({ to: "/settings/datalets" })}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="page" style={{ textAlign: "center", padding: "2rem" }}>
      <h2>Confirm</h2>
      <p>
        {codeType === "COPY"
          ? "Someone is offering you a copy of their datalet."
          : "You've been invited to sync a vault."}
      </p>
      <p>Code: <code>{code}</code></p>
      <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
        <button
          type="button"
          className="primary-btn"
          onClick={() => {
            // Copy code to clipboard and navigate
            navigator.clipboard.writeText(code);
            navigate({ to: "/settings/datalets" });
          }}
        >
          Copy Code & Go to Settings
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => navigate({ to: "/" })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
