import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { MemoryRouter, Routes, Route } from "react-router-dom";

test("location picker follows saved coordinates and cleans up SDK resources", async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const maps: FakeMap[] = [];
  const markers: FakeMarker[] = [];
  let cleared = 0;
  class FakeMap {
    center: unknown;
    listeners = new Map<string, (event: unknown) => void>();
    constructor(_el: unknown, options: { center: unknown }) { this.center = options.center; maps.push(this); }
    panTo(position: unknown) { this.center = position; }
    setZoom() {}
    addListener(name: string, callback: (event: unknown) => void) { this.listeners.set(name, callback); return { remove: () => this.listeners.delete(name) }; }
  }
  class FakeMarker {
    position: unknown;
    map: unknown;
    constructor(options: { position: unknown; map: unknown }) { Object.assign(this, options); markers.push(this); }
    addListener() { return { remove() {} }; }
  }
  class FakeAutocomplete extends dom.window.HTMLElement {}
  dom.window.customElements.define("test-place-autocomplete", FakeAutocomplete);
  const libraries: Record<string, unknown> = {
    maps: { Map: FakeMap }, marker: { AdvancedMarkerElement: FakeMarker },
    places: { PlaceAutocompleteElement: FakeAutocomplete },
  };
  Object.assign(globalThis, { google: { maps: { ColorScheme: { DARK: "dark" }, RenderingType: { VECTOR: "vector" },
    event: { clearInstanceListeners() { cleared++; } } } }, mapsTestLibrary: async (name: string) => libraries[name] });
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@googlemaps/js-api-loader": fileURLToPath(new URL("./fixtures/maps.ts", import.meta.url)) } } });
  t.after(async () => { await vite.close(); dom.window.close(); });
  // Vite supplies import.meta.env and the same JSX transform used by the app.
  const { LocationPicker } = await vite.ssrLoadModule("/src/components/LocationPicker.tsx");
  const container = dom.window.document.getElementById("root")!;

  await t.test("loaded maps follow prop updates and call the latest callback without reinitializing", async () => {
    const root = createRoot(container);
    const calls: unknown[] = [];
    await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.7917, longitude: 90.4167, onChange: () => calls.push("old") })); });
    assert.equal(maps.length, 1);
    await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.795, longitude: 90.4047, onChange: (...value: unknown[]) => calls.push(value) })); });
    assert.equal(maps.length, 1);
    assert.deepEqual(markers[0].position, { lat: 23.795, lng: 90.4047 });
    assert.deepEqual(maps[0].center, { lat: 23.795, lng: 90.4047 });
    await act(async () => { maps[0].listeners.get("click")!({ latLng: { lat: () => 23.8, lng: () => 90.4 } }); });
    assert.deepEqual(calls, [[23.8, 90.4]]);
    await act(async () => root.unmount());
    assert.equal(container.querySelectorAll("test-place-autocomplete").length, 0);
    assert.equal(markers[0].map, null);
    assert.ok(cleared >= 2);
  });

  await t.test("coordinates arriving during SDK loading are used at initialization", async () => {
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    Object.assign(globalThis, { mapsTestLibrary: async (name: string) => { await wait; return libraries[name]; } });
    const root = createRoot(container);
    const onChange = () => {};
    await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.79, longitude: 90.41, onChange })); });
    await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.87, longitude: 90.37, onChange })); });
    await act(async () => { release(); await wait; });
    assert.deepEqual(markers.at(-1)?.position, { lat: 23.87, lng: 90.37 });
    await act(async () => root.unmount());
  });

  await t.test("StrictMode leaves one autocomplete and one active marker", async () => {
    const root = createRoot(container);
    await act(async () => { root.render(createElement(StrictMode, null, createElement(LocationPicker, { latitude: 23.79, longitude: 90.41, onChange() {} }))); });
    assert.equal(container.querySelectorAll("test-place-autocomplete").length, 1);
    assert.equal(markers.filter(marker => marker.map !== null).length, 1);
    await act(async () => root.unmount());
  });

  await t.test("late autocomplete results cannot overwrite newer selections, saved props or an unmounted picker", async () => {
    const root = createRoot(container);
    const calls: number[][] = [];
    const onChange = (...position: number[]) => calls.push(position);
    const pending = () => {
      let release!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
      const event = new dom.window.Event("gmp-select");
      Object.assign(event, { placePrediction: { toPlace: () => ({
        fetchFields: () => promise, location: { lat: () => 23.8, lng: () => 90.4 },
      }) } });
      container.querySelector("test-place-autocomplete")!.dispatchEvent(event);
      return { release, reject };
    };
    try {
      await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.79, longitude: 90.41, onChange })); });
      let first!: ReturnType<typeof pending>;
      let second!: ReturnType<typeof pending>;
      await act(async () => { first = pending(); second = pending(); });
      await act(async () => second.release());
      await act(async () => first.release());
      assert.deepEqual(calls, [[23.8, 90.4]]);
      let stale!: ReturnType<typeof pending>;
      await act(async () => { stale = pending(); });
      await act(async () => { root.render(createElement(LocationPicker, { latitude: 23.87, longitude: 90.37, onChange })); });
      await act(async () => stale.release());
      assert.deepEqual(calls, [[23.8, 90.4]]);
      assert.deepEqual(markers.at(-1)?.position, { lat: 23.87, lng: 90.37 });
      let failed!: ReturnType<typeof pending>;
      await act(async () => { failed = pending(); failed.reject(new Error("Lookup failed")); });
      assert.match(container.textContent!, /Could not find that location/);
      await act(async () => { stale = pending(); });
      await act(async () => root.unmount());
      await act(async () => stale.release());
      assert.deepEqual(calls, [[23.8, 90.4]]);
    } finally { await act(async () => root.unmount()); }
  });

  await t.test("editing a legacy listing preserves valid zero coordinates in the saved payload", async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    dom.window.localStorage.setItem("token", "synthetic-test-token");
    const originalFetch = globalThis.fetch;
    const bodies: { latitude: number; longitude: number }[] = [];
    globalThis.fetch = (async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/auth/me")) return Response.json({ user: { id: 1, name: "Owner", is_owner: true } });
      if (path.endsWith("/listings/amenities")) return Response.json({ amenities: [] });
      assert.ok(path.endsWith("/listings/1"), path);
      if (options?.method === "PATCH") {
        bodies.push(JSON.parse(String(options.body)));
        return Response.json({ message: "Updated" });
      }
      return Response.json({ listing: { id: 1, title: "Legacy home", description: "Quiet home", latitude: "0", longitude: "0",
        bedroom_count: 2, bathroom_count: 1, on_which_floor: 1, rent: 10000 } });
    }) as typeof fetch;
    const { ListingFormPage } = await vite.ssrLoadModule("/src/pages/ListingFormPage.tsx");
    const { AuthProvider } = await vite.ssrLoadModule("/src/context/AuthContext.tsx");
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(MemoryRouter, { initialEntries: ["/listings/1/edit"] },
        createElement(AuthProvider, null, createElement(Routes, null,
          createElement(Route, { path: "/listings/:id/edit", element: createElement(ListingFormPage) }),
          createElement(Route, { path: "/listings/:id", element: createElement("p", null, "Saved") }))))); });
      assert.match(container.textContent!, /Lat: 0\.00000, Lng: 0\.00000/);
      await act(async () => { container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].latitude, 0);
      assert.equal(bodies[0].longitude, 0);
    } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; }
  });
});
