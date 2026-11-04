import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client";
import { bdt } from "../api/rentals";
type Attempt = {
  id: string;
  state: string;
  amount: string;
  provider: string;
  checkout_url: string | null;
  last_error: string | null;
};
export function SandboxPayment({
  paymentId,
  isTenant,
  payable,
  onChanged,
  provider,
}: {
  paymentId: number;
  isTenant: boolean;
  payable: boolean;
  onChanged: () => void;
  provider?: string;
}) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const previous = useRef("");
  async function load() {
    const result = await apiClient.get<{ attempts: Attempt[] }>(
      `/payment-sandbox/payments/${paymentId}`,
    );
    const next = result.attempts.map((a) => a.id + ":" + a.state).join(",");
    if (
      (previous.current && previous.current !== next) ||
      (!previous.current &&
        result.attempts.some((a) => a.state === "succeeded"))
    )
      changed.current();
    previous.current = next;
    setAttempts(result.attempts);
  }
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active)
        void load().catch((e) => {
          if (active) setError(e.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [paymentId]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sandbox request failed");
    } finally {
      setBusy(false);
    }
  }
  const open = attempts.find((a) =>
    ["initiating", "pending", "review"].includes(a.state),
  );
  return (
    <section className="rental-card" aria-label="Sandbox payment">
      <strong>TEST payments only</strong>
      <p>
        {provider === "simulated"
          ? "Simulated payment — no real money transferred. Internal development simulator, not an official gateway."
          : "No real money transferred. No landlord payout. Checkout uses shurjoPay sandbox."}
      </p>
      {error && <p role="alert">{error}</p>}
      {isTenant && payable && !open && (
        <button
          className="rental-button"
          disabled={busy}
          onClick={() =>
            void run(() =>
              apiClient.post(`/payment-sandbox/payments/${paymentId}`, {}),
            )
          }
        >
          {busy
            ? "Preparing checkout…"
            : provider === "simulated"
              ? "Start simulated checkout"
              : "Pay Online — Sandbox"}
        </button>
      )}
      {attempts.map((a) => (
        <div key={a.id} className="mt-3">
          <p role="status">
            {a.provider === "simulated" ? "SIMULATED" : "TEST"} {bdt(a.amount)}{" "}
            ·{" "}
            {a.state === "pending"
              ? "Waiting for server-side verification"
              : a.state === "succeeded"
                ? a.provider === "simulated"
                  ? "Simulation confirmed — acknowledgment queued"
                  : "Verified by sandbox — acknowledgment queued"
                : a.state}
          </p>
          {isTenant && a.provider === "simulated" && a.state === "pending" && (
            <div aria-label="Simulated checkout outcomes">
              {(["succeeded", "failed", "cancelled"] as const).map(
                (outcome) => (
                  <button
                    key={outcome}
                    className="rental-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        apiClient.post(
                          `/payment-sandbox/attempts/${a.id}/simulate`,
                          { outcome },
                        ),
                      )
                    }
                  >
                    Simulate {outcome}
                  </button>
                ),
              )}
            </div>
          )}
          {a.last_error && <p>{a.last_error}</p>}
          {isTenant && a.state === "pending" && a.checkout_url && (
            <a
              className="rental-button"
              href={a.checkout_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open sandbox checkout ↗
            </a>
          )}
          {["pending", "review"].includes(a.state) && (
            <button
              className="rental-button ml-3"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  apiClient.post(
                    `/payment-sandbox/attempts/${a.id}/verify`,
                    {},
                  ),
                )
              }
            >
              Check verification
            </button>
          )}
          {a.state === "succeeded" && (
            <p>
              Download the TEST acknowledgment in Installment history below. PDF
              preparation may take a few seconds.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
