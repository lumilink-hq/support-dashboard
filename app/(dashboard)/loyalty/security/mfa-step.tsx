"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// The two staff MFA steps (0210), in the browser so Supabase can upgrade the
// session cookie to aal2 when the code checks out:
//   enroll: create a TOTP factor, show its QR code, confirm with a first code
//   verify: enter a code from the authenticator already set up

const inputCls =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

export function MfaStep({ mode, next }: { mode: "enroll" | "verify"; next: string }) {
  const router = useRouter();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) return setError(listError.message);
      if (mode === "verify") {
        const f = data.totp[0];
        return f ? setFactorId(f.id) : setError("No authenticator found. Reload the page to set one up.");
      }
      // A setup abandoned earlier leaves an unverified factor behind; clear it first.
      for (const f of data.all.filter((x) => x.status === "unverified")) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `LumiLink staff ${new Date().toISOString().slice(0, 10)}`,
      });
      if (enrollError) return setError(enrollError.message);
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret);
    })();
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (verifyError) {
      setBusy(false);
      setCode("");
      return setError(/invalid|expired/i.test(verifyError.message) ? "That code didn't match. Try the current one." : verifyError.message);
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
      {mode === "enroll" ? (
        <>
          <h2 className="text-sm font-semibold text-gray-900">1. Scan this with your authenticator app</h2>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL from Supabase, not an optimizable asset
            <img src={qr} alt="Authenticator QR code" width={180} height={180} className="mx-auto mt-4" />
          ) : (
            <p className="mt-4 text-sm text-gray-500">Preparing…</p>
          )}
          {secret ? (
            <p className="mt-3 break-all text-center text-xs text-gray-500">
              Can&rsquo;t scan? Enter this key: <span className="font-mono text-gray-800">{secret}</span>
            </p>
          ) : null}
          <h2 className="mt-6 text-sm font-semibold text-gray-900">2. Enter the 6-digit code it shows</h2>
        </>
      ) : (
        <h2 className="text-sm font-semibold text-gray-900">Enter the 6-digit code from your authenticator app</h2>
      )}

      <form onSubmit={submit} className="mt-3 space-y-3">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6-digit code"
          placeholder="123456"
          className={inputCls}
          required
          minLength={6}
        />
        {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
        <button
          type="submit"
          disabled={busy || !factorId || code.length !== 6}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
        >
          {busy ? "Checking…" : mode === "enroll" ? "Turn on and continue" : "Continue"}
        </button>
      </form>
      <p className="mt-4 text-xs text-gray-400">
        Lost your authenticator? Ask another LumiLink admin to reset it (removes your factor in Supabase).
      </p>
    </section>
  );
}
