import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { createServer } from "vite";

test("database area catalog loads once for consumers, fails visibly and can retry", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const originalFetch = globalThis.fetch;
  let fail = true;
  let areaRequests = 0;
  globalThis.fetch = (async input => {
    if (String(input).endsWith("/listings/stats")) return Response.json({ approvedApartments: 0, signedAgreements: 0, areasWithListings: 0 });
    assert.ok(String(input).endsWith("/areas"));
    areaRequests++;
    return new Response(JSON.stringify(fail ? { error: "Unavailable" } : { areas: [{ id: 44, name: "Gulshan", city: "Dhaka" }, { id: 99, name: "Shyamoli", city: "Dhaka" }] }), { status: fail ? 503 : 200 });
  }) as typeof fetch;
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { AreaProvider } = await vite.ssrLoadModule("/src/context/AreaProvider.tsx");
  const { useAreas } = await vite.ssrLoadModule("/src/context/AreaContext.ts");
  const { Hero } = await vite.ssrLoadModule("/src/components/Hero.tsx");
  function CatalogConsumer() {
    const { areas, loading } = useAreas();
    return createElement("p", { "data-testid": "catalog" }, loading ? "Loading" : areas.map((area: { id: number; name: string }) => `${area.id}:${area.name}`).join(","));
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; await vite.close(); dom.window.close(); });
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AreaProvider, null,
    createElement(Hero), createElement(CatalogConsumer), createElement(CatalogConsumer)))); });
  assert.equal(areaRequests, 1);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /could not be loaded/);
  const areaSelect = container.querySelector("select")!;
  assert.equal(areaSelect.disabled, true);
  fail = false;
  await act(async () => { (container.querySelector('[role="alert"] button') as HTMLButtonElement).click(); });
  assert.equal(areaRequests, 2);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(areaSelect.disabled, false);
  assert.ok([...areaSelect.options].some(option => option.value === "Shyamoli"));
  assert.equal(container.querySelector('[data-testid="catalog"]')?.textContent, "44:Gulshan,99:Shyamoli");
});

test("an unresolved area never displays unrelated public listings while pending or after failure", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/areas")) return Response.json({ areas: [{ id: 44, name: "Gulshan", city: "Dhaka" }] });
    if (url.pathname.endsWith("/listings/amenities")) return Response.json({ amenities: [] });
    if (url.pathname.endsWith("/listings/search")) {
      assert.equal(url.searchParams.get("area"), "unknown-place-xyz");
      assert.equal(url.searchParams.has("areaId"), false);
      return Response.json({ error: "The requested area could not be verified." }, { status: 400 });
    }
    assert.ok(url.pathname.endsWith("/listings"), url.pathname);
    return Response.json({ listings: [{ id: 1, owner_id: 10, title: "Unrelated public home", area_id: 44, status: "approved", rent: 10000 }] });
  }) as typeof fetch;
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { AreaProvider } = await vite.ssrLoadModule("/src/context/AreaProvider.tsx");
  const { AuthProvider } = await vite.ssrLoadModule("/src/context/AuthContext.tsx");
  const { ListingsPage } = await vite.ssrLoadModule("/src/pages/ListingsPage.tsx");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; await vite.close(); dom.window.close(); });
  await act(async () => { root.render(createElement(MemoryRouter, { initialEntries: ["/listings?area=unknown-place-xyz"] },
    createElement(AuthProvider, null, createElement(AreaProvider, null, createElement(ListingsPage))))); });
  assert.doesNotMatch(container.textContent!, /Unrelated public home/);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.match(container.textContent!, /requested area could not be verified/);
  assert.doesNotMatch(container.textContent!, /Unrelated public home/);
});

test("server-resolved aliases also filter the owner's local listings", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  dom.window.localStorage.setItem("token", "synthetic-test-token");
  const user = { id: 1, name: "Owner", is_owner: true, is_verifier: false };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/me")) return Response.json({ user });
    if (path.endsWith("/areas")) return Response.json({ areas: [{ id: 44, name: "Gulshan", city: "Dhaka" }] });
    if (path.endsWith("/listings/amenities")) return Response.json({ amenities: [] });
    if (path.endsWith("/listings/search")) return Response.json({ listings: [], nextCursor: null, resolvedAreaId: 44 });
    if (path.endsWith("/listings/my")) return Response.json({ listings: [
      { id: 1, owner_id: 1, title: "Owner Gulshan apartment", area_id: 44, status: "waiting", rent: 10000 },
      { id: 2, owner_id: 1, title: "Owner unrelated apartment", area_id: 45, status: "waiting", rent: 10000 },
    ] });
    assert.ok(path.endsWith("/listings"), path);
    return Response.json({ listings: [] });
  }) as typeof fetch;
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { AreaProvider } = await vite.ssrLoadModule("/src/context/AreaProvider.tsx");
  const { AuthProvider } = await vite.ssrLoadModule("/src/context/AuthContext.tsx");
  const { ListingsPage } = await vite.ssrLoadModule("/src/pages/ListingsPage.tsx");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; await vite.close(); dom.window.close(); });
  await act(async () => { root.render(createElement(MemoryRouter, { initialEntries: ["/listings?area=Gulshan%2C%20Dhaka"] },
    createElement(AuthProvider, null, createElement(AreaProvider, null, createElement(ListingsPage))))); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.match(container.textContent!, /Owner Gulshan apartment/);
  assert.doesNotMatch(container.textContent!, /Owner unrelated apartment/);
});
