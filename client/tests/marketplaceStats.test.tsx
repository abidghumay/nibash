import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("marketplace metrics show loading, actual counts including zero, and retry after failure", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const originalFetch = globalThis.fetch;
  let respond!: (response: Response) => void;
  globalThis.fetch = (async input => {
    assert.ok(String(input).endsWith("/listings/stats"));
    return new Promise<Response>(resolve => { respond = resolve; });
  }) as typeof fetch;
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { MarketplaceStats } = await vite.ssrLoadModule("/src/components/MarketplaceStats.tsx");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; await vite.close(); dom.window.close(); });
  await act(async () => { root.render(createElement(MarketplaceStats)); });
  assert.equal(container.querySelector('[aria-busy="true"]') !== null, true);
  assert.doesNotMatch(container.textContent!, /1,200|100%|12\+/);
  await act(async () => { respond(Response.json({ error: "Unavailable" }, { status: 503 })); });
  assert.match(container.textContent!, /Counts unavailable/);
  await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
  await act(async () => { respond(Response.json({ approvedApartments: 17, signedAgreements: 0, areasWithListings: 6 })); });
  assert.deepEqual([...container.querySelectorAll("dd")].map(el => el.textContent), ["17", "0", "6"]);
  assert.match(container.textContent!, /Approved apartments/);
  assert.equal(container.querySelector("button"), null);
});
