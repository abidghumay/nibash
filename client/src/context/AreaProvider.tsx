import { useEffect, useState, type ReactNode } from "react";
import { AreaContext } from "./AreaContext";
import { apiClient } from "../api/client";
import type { Area } from "../utils/areaLookup";

export function AreaProvider({ children }: { children: ReactNode }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiClient.get<{ areas: Area[] }>("/areas", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setAreas(data.areas); })
      .catch(() => { if (!controller.signal.aborted) setError("Area names could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  return (
    <AreaContext.Provider value={{ areas, loading, error }}>
      {error && <div role="alert" className="bg-slate-900 px-4 py-3 text-center text-sm text-white">
        {error}{" "}
        <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry loading areas</button>
      </div>}
      {children}
    </AreaContext.Provider>
  );
}
