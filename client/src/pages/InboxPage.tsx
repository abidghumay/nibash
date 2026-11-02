import { useEffect, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getInbox, markInboxRead, setMessageRead, type InboxMessage, type InboxPage as InboxPageData } from "../api/notifications";
import { useAuth } from "../context/AuthContext";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/15 px-4 text-sm text-slate-200 transition-colors hover:border-white/30 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer";
const timestamp = new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Dhaka"});

export function InboxPage() {
  const { user,token } = useAuth();
  const navigate = useNavigate();
  const [unread,setUnread] = useState(false);
  const [cursors,setCursors] = useState<number[]>([]);
  const [page,setPage] = useState<InboxPageData>({notifications:[],nextCursor:null});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const before = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage({notifications:[],nextCursor:null});
    getInbox(unread,before,controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load your inbox.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  },[unread,before,refresh,user?.id,token]);

  useEffect(() => {
    function onFocus() { if (!document.hidden) setRefresh(value => value+1); }
    window.addEventListener("focus",onFocus);
    return () => window.removeEventListener("focus",onFocus);
  },[]);

  async function updateRead(message: InboxMessage) {
    setBusy(true);
    setError("");
    try {
      await setMessageRead(message.id,!message.read_at);
      setRefresh(value => value+1);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update this message."); }
    finally { setBusy(false); }
  }

  async function openMessage(event: MouseEvent<HTMLAnchorElement>,message: InboxMessage) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setBusy(true);
    try {
      if (!message.read_at) await setMessageRead(message.id,true);
      navigate(`/contracts/${message.contract_id}`);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not open this message."); }
    finally { setBusy(false); }
  }

  async function readAll() {
    setBusy(true);
    setError("");
    try {
      await markInboxRead();
      setCursors([]);
      setRefresh(value => value+1);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not mark messages as read."); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto min-h-[75vh] max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-400">Messages from Nibash</p>
          <h1 className="font-serif text-4xl text-white sm:text-5xl">Your inbox</h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">Payment updates, contract milestones, and reminders. Everything that needs your attention, in one place.</p>
        </div>
        <button type="button" className={`${control} shrink-0 self-start`} onClick={readAll} disabled={busy || loading || !page.notifications.length}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">done_all</span>Mark all as read
        </button>
      </div>

      <div className="mb-6 flex items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex gap-2" role="group" aria-label="Filter messages">
          {[false,true].map(value => <button key={String(value)} type="button" aria-pressed={unread===value}
            disabled={busy} onClick={() => {setUnread(value);setCursors([]);}}
            className={`${control} ${unread===value ? "bg-white/10 border-white/30 text-white" : "text-slate-400"}`}>
            {value ? "Unread" : "All messages"}
          </button>)}
        </div>
        <button type="button" className={control} aria-label="Refresh inbox" disabled={loading || busy} onClick={() => setRefresh(value => value+1)}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">refresh</span><span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {error && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">
        <p>{error}</p><button type="button" className={control} onClick={() => setRefresh(value => value+1)}>Try again</button>
      </div>}

      <div aria-busy={loading}>
        {loading ? <p role="status" className="py-20 text-center text-slate-400">Loading your messages…</p>
          : !page.notifications.length && !error ? <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-20 text-center">
            <span className="material-symbols-outlined mb-4 text-4xl text-slate-400" aria-hidden="true">{unread ? "mark_email_read" : "inbox"}</span>
            <h2 className="mb-2 text-xl text-white">{unread ? "You're all caught up" : "No messages yet"}</h2>
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-slate-400">{unread ? "Your unread messages will appear here." : "Nibash will let you know when there is a payment update or news about your contract."}</p>
          </div>
          : <ul className="overflow-hidden rounded-2xl border border-white/10 divide-y divide-white/10">
            {page.notifications.map(message => <li key={message.id} className={`p-5 sm:p-6 ${message.read_at ? "bg-white/[0.015]" : "bg-white/[0.055]"}`}>
              <div className="flex gap-4">
                <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300 sm:flex">
                  <span className="material-symbols-outlined" aria-hidden="true">{message.kind.startsWith("payment") ? "payments" : "description"}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    <span className="font-semibold tracking-wide text-slate-300">Nibash</span>
                    <time dateTime={message.created_at}>{timestamp.format(new Date(message.created_at))}</time>
                    {!message.read_at && <span className="rounded-full border border-slate-400/30 bg-slate-300/10 px-2 py-0.5 text-slate-200">Unread</span>}
                  </div>
                  <h2 className="text-lg font-medium leading-snug text-white">{message.title}</h2>
                  <p className="mt-2 break-words text-sm leading-relaxed text-slate-300">{message.body}</p>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <Link to={`/contracts/${message.contract_id}`} onClick={event => openMessage(event,message)}
                      className={`${control} ${busy ? "pointer-events-none opacity-50" : ""}`}>
                      {message.kind.startsWith("payment") ? "View payment & contract" : "View contract"}<span className="material-symbols-outlined text-base" aria-hidden="true">arrow_forward</span>
                    </Link>
                    <button type="button" disabled={busy} className={control} onClick={() => updateRead(message)}>{message.read_at ? "Mark unread" : "Mark as read"}</button>
                  </div>
                </div>
              </div>
            </li>)}
          </ul>}
      </div>

      {!loading && (cursors.length>0 || page.nextCursor!==null) && <nav aria-label="Inbox pages" className="mt-6 flex items-center justify-between gap-4">
        <button type="button" disabled={!cursors.length || busy} className={control} onClick={() => setCursors(values => values.slice(0,-1))}>Newer messages</button>
        <button type="button" disabled={page.nextCursor===null || busy} className={control} onClick={() => { if (page.nextCursor!==null) setCursors(values => [...values,page.nextCursor!]); }}>Older messages</button>
      </nav>}
    </div>
  );
}
