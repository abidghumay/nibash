import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiClient } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function InboxBell() {
  const { user,token } = useAuth();
  const userId = user?.id;
  const { pathname } = useLocation();
  const [count,setCount] = useState<number | null>(null);

  useEffect(() => {
    setCount(null);
    if (!token || !userId) return;
    const controller = new AbortController();
    let requestVersion = 0;
    async function refresh() {
      if (document.visibilityState === "hidden") return;
      const version = ++requestVersion;
      try {
        const result = await apiClient.get<{count: number}>("/notifications/unread-count",{signal:controller.signal});
        if (!controller.signal.aborted && version === requestVersion) setCount(result.count);
      } catch {
        if (!controller.signal.aborted && version === requestVersion) setCount(null);
      }
    }
    void refresh();
    const interval = window.setInterval(refresh,60_000);
    window.addEventListener("focus",refresh);
    window.addEventListener("nibash:inbox-changed",refresh);
    document.addEventListener("visibilitychange",refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus",refresh);
      window.removeEventListener("nibash:inbox-changed",refresh);
      document.removeEventListener("visibilitychange",refresh);
    };
  },[token,userId,pathname]);

  return (
    <Link to="/inbox" aria-label={count === null ? "Inbox" : `Inbox, ${count} unread messages`}
      title="Inbox" className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${pathname === "/inbox" ? "border-white/30 bg-white/10 text-white" : "border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"}`}>
      <span className="material-symbols-outlined" aria-hidden="true">notifications</span>
      {count !== null && count > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full bg-slate-200 px-1 text-center text-[11px] font-bold leading-5 text-slate-950">{count > 99 ? "99+" : count}</span>}
    </Link>
  );
}
