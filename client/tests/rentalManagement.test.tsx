import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { createServer } from "vite";

test("My Tenants handles failures, retry, empty groups and authorized relationship links", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  let fail = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      fail
        ? { error: "Synthetic service unavailable" }
        : {
            tenants: [
              {
                contract_id: 7,
                tenant_id: 2,
                tenant_name: "Synthetic Tenant",
                listing_title: "Synthetic unit",
                effective_rent: "20000",
                status: "signed",
                tenant_group: "current",
                dmp_status: "not_prepared",
              },
            ],
            pagination: { page: 1, total: 1, totalPages: 1 },
          },
      { status: fail ? 503 : 200 },
    )) as typeof fetch;
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { MyTenantsPage } = await vite.ssrLoadModule(
    "/src/pages/MyTenantsPage.tsx",
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    await vite.close();
    dom.window.close();
  });
  await act(async () =>
    root.render(
      createElement(MemoryRouter, null, createElement(MyTenantsPage)),
    ),
  );
  assert.match(
    dom.window.document.querySelector('[role="alert"]')!.textContent!,
    /unavailable/,
  );
  fail = false;
  await act(async () => {
    (
      dom.window.document.querySelector(
        '[role="alert"] button',
      ) as HTMLButtonElement
    ).click();
  });
  assert.equal(
    dom.window.document
      .querySelector('a[href="/contracts/7"]')
      ?.textContent?.includes("Synthetic Tenant"),
    true,
  );
  assert.match(dom.window.document.body.textContent!, /Not prepared/);
});

test("rental panel shows historical verification and never claims police verification", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      contract: {
        contract_id: 1,
        owner_id: 1,
        tenant_id: 2,
        protection_state: "needs_verification",
        effective_rent: "20000",
        rent: "20000",
        advance_rent: "0",
        security_deposit: "5000",
        status: "signed",
      },
      documents: [],
      revisions: [],
      payments: [],
      events: [],
      rules: [],
      dmp: { status: "submitted_manually_unverified" },
      dmp_guidance: {
        message: "Preparation only; consult DMP.",
        form_url:
          "https://dmp.gov.bd/important-forms/tenant-registration-form/",
      },
    })) as typeof fetch;
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { RentalManagementPanel } = await vite.ssrLoadModule(
    "/src/components/RentalManagementPanel.tsx",
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    await vite.close();
    dom.window.close();
  });
  await act(async () =>
    root.render(
      createElement(RentalManagementPanel, { contractId: "1", userId: 2 }),
    ),
  );
  assert.match(dom.window.document.body.textContent!, /Verification needed/);
  assert.equal(dom.window.document.querySelector('input[name="rent"]'), null);
  await act(async () => {
    [...dom.window.document.querySelectorAll("button")]
      .find((b) => b.textContent === "DMP preparation")!
      .click();
  });
  assert.match(
    dom.window.document.body.textContent!,
    /Submitted manually — unverified/,
  );
  assert.ok(!dom.window.document.body.textContent!.includes("Police verified"));
  assert.equal(dom.window.document.querySelector('input[type="file"]'), null);
});
