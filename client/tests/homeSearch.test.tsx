import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createServer } from "vite";

test("home search hands text to NLP while preserving ordinary browsing", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const originalFormData = globalThis.FormData;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Routes, Route, useLocation } = await import("react-router-dom");
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { Hero } = await vite.ssrLoadModule("/src/components/Hero.tsx");
  const { ListingsPage } = await vite.ssrLoadModule("/src/pages/ListingsPage.tsx");
  const { AuthProvider } = await vite.ssrLoadModule("/src/context/AuthContext.tsx");
  const { AreaProvider } = await vite.ssrLoadModule("/src/context/AreaProvider.tsx");
  const originalFetch = globalThis.fetch;
  const container = dom.window.document.getElementById("root")!;
  let location = "";
  const interpretations: string[] = [];
  const searches: URLSearchParams[] = [];
  let respond!: (response: Response) => void;
  let verifier = false;
  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/auth/me")) return Response.json({ user: { id: 1, is_verifier: verifier } });
    if (url.pathname.endsWith("/verify/listings") || url.pathname.endsWith("/listings/my")) return Response.json({ listings: [] });
    if (url.pathname.endsWith("/areas")) return Response.json({ areas: [{ id: 2, name: "Dhanmondi", city: "Dhaka" }] });
    if (url.pathname.endsWith("/listings/stats")) return Response.json({ approvedApartments: 0, signedAgreements: 0, areasWithListings: 0 });
    if (url.pathname.endsWith("/listings/amenities")) return Response.json({ amenities: [] });
    if (url.pathname.endsWith("/listings/search/interpret")) {
      interpretations.push(JSON.parse(String(options?.body)).query);
      return new Promise<Response>(resolve => { respond = resolve; });
    }
    if (url.pathname.endsWith("/listings/search")) {
      searches.push(url.searchParams);
      return Response.json({ listings: [], nextCursor: null });
    }
    assert.ok(url.pathname.endsWith("/listings"), url.pathname);
    return Response.json({ listings: [] });
  }) as typeof fetch;
  t.after(async () => { globalThis.fetch = originalFetch; globalThis.FormData = originalFormData; await vite.close(); dom.window.close(); });
  function LocationProbe() {
    const current = useLocation();
    location = current.pathname + current.search;
    return null;
  }
  async function mount(entry = "/") {
    interpretations.length = 0;
    searches.length = 0;
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(MemoryRouter, { initialEntries: [entry] },
        createElement(AuthProvider, null, createElement(AreaProvider, null,
          createElement(LocationProbe), createElement(Routes, null,
            createElement(Route, { path: "/", element: createElement(Hero) }),
            createElement(Route, { path: "/listings", element: createElement(ListingsPage) })))))));
    });
    return root;
  }
  async function submitHome(query: string) {
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      const selects = container.querySelectorAll("select");
      for (const [index, value] of ["Dhanmondi", "3", "30000"].entries()) {
        selects[index].value = value;
        selects[index].dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      }
    });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  }
  const naturalButton = () => [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Natural language"))!;

  for (const query of ["  3 bedrooms under 30k with a lift  ", "ধানমন্ডিতে ৩ বেডরুম ৩০ হাজারের মধ্যে"]) {
    await t.test(`text submission automatically interprets ${query.trim()}`, async () => {
      const root = await mount();
      try {
        await submitHome(query);
        assert.equal(new URL(location, "http://localhost").searchParams.get("mode"), "natural");
        assert.equal(naturalButton().getAttribute("aria-pressed"), "true");
        assert.equal(container.querySelector("textarea")?.value, query.trim());
        assert.deepEqual(interpretations, [query.trim()], "interpret exactly once, including under StrictMode");
        assert.equal(searches.length, 0, "do not run ordinary search while interpreting");
        await act(async () => { respond(Response.json({ status: "interpreted", filters: { bedrooms: 3 }, preferences: [], unsupported: [], warnings: [], latencyMs: 1 })); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(searches.length, 1);
        assert.equal(searches[0].get("strict"), "1");
        assert.equal(searches[0].get("q"), null);
        assert.equal(searches[0].get("area"), "Dhanmondi");
        assert.equal(searches[0].get("bedrooms"), "3");
        assert.equal(searches[0].get("maxRent"), "30000");
        await act(async () => { naturalButton().click(); });
        assert.match(container.textContent!, /Interpreted requirements/, "clicking the active mode keeps the current interpretation");
        await act(async () => {
          const budget = container.querySelectorAll("form")[1].querySelectorAll("select")[2];
          budget.value = "50000";
          budget.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.deepEqual(interpretations, [query.trim()], "manual filters must not call the model again");
        assert.equal(naturalButton().getAttribute("aria-pressed"), "true");
      } finally { await act(async () => root.unmount()); }
    });
  }
  await t.test("blank text uses ordinary search with the selected manual filters", async () => {
    const root = await mount();
    try {
      await submitHome("   ");
      assert.equal(naturalButton().getAttribute("aria-pressed"), "false");
      assert.equal(container.querySelector("textarea"), null);
      assert.equal(interpretations.length, 0);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      assert.equal(searches.at(-1)?.get("area"), "Dhanmondi");
      assert.equal(searches.at(-1)?.get("bedrooms"), "3");
    } finally { await act(async () => root.unmount()); }
  });
  await t.test("home text search opens approved NLP results for verifiers too", async () => {
    verifier = true;
    dom.window.localStorage.setItem("token", "synthetic-verifier-token");
    const root = await mount();
    try {
      await submitHome("quiet home");
      assert.deepEqual(interpretations, ["quiet home"]);
      assert.equal(naturalButton().getAttribute("aria-pressed"), "true");
      assert.equal(new URL(location, "http://localhost").searchParams.get("view"), "approved");
    } finally {
      await act(async () => root.unmount());
      dom.window.localStorage.clear();
      verifier = false;
    }
  });
  await t.test("an NLP error stays in NLP until the user explicitly chooses ordinary search", async () => {
    const root = await mount("/listings?mode=natural&q=quiet+home");
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.deepEqual(interpretations, ["quiet home"]);
      await act(async () => { respond(Response.json({ error: "Interpreter unavailable" }, { status: 503 })); });
      assert.match(container.textContent!, /Interpreter unavailable/);
      assert.equal(searches.length, 0);
      await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Use ordinary search")!.click(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      assert.equal(naturalButton().getAttribute("aria-pressed"), "false");
      assert.equal(searches.at(-1)?.get("q"), "quiet home");
      assert.equal(new URL(location, "http://localhost").searchParams.has("mode"), false);
    } finally { await act(async () => root.unmount()); }
  });
  await t.test("existing ordinary keyword links keep their ordinary behavior", async () => {
    const root = await mount("/listings?q=spacious");
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      assert.equal(naturalButton().getAttribute("aria-pressed"), "false");
      assert.equal(interpretations.length, 0);
      assert.equal(searches.at(-1)?.get("q"), "spacious");
    } finally { await act(async () => root.unmount()); }
  });
});
