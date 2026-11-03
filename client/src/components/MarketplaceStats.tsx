import { useEffect, useState } from "react";
import { apiClient } from "../api/client";

type Counts = { approvedApartments: number; signedAgreements: number; areasWithListings: number };
const metrics = [
  ["approvedApartments", "Approved apartments"],
  ["signedAgreements", "Signed rental agreements"],
  ["areasWithListings", "Areas with listings"],
] as const;

export function MarketplaceStats() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    apiClient.get<Counts>("/listings/stats", { signal: controller.signal })
      .then(data => {
        if (!metrics.every(([key]) => Number.isSafeInteger(data[key]) && data[key] >= 0)) throw new Error("Invalid counts");
        if (!controller.signal.aborted) setCounts(data);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="pt-3 border-t border-white/10" aria-busy={!counts && !failed} aria-label="Live marketplace counts">
      <dl className="grid grid-cols-3 gap-4">
        {metrics.map(([key, label]) => (
          <div key={key} className="flex flex-col-reverse justify-end gap-1">
            <dt className="text-[10px] sm:text-xs text-[#94a3b8] uppercase tracking-wider font-label-sm">{label}</dt>
            <dd className="text-2xl lg:text-3xl font-light text-[#f8f9fa] font-serif tabular-nums">{counts ? counts[key].toLocaleString("en-BD") : "—"}</dd>
          </div>
        ))}
      </dl>
      {failed && <p role="status" className="mt-3 text-xs text-slate-400">Counts unavailable. <button type="button" onClick={() => setAttempt(value => value + 1)} className="text-slate-200 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Retry</button></p>}
    </div>
  );
}
