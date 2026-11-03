import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { createServer } from "vite";

test("public policy explains the actual rental rules and links authoritative Bangladesh law", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/policies/rental-protection",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
  });
  const { RentalPolicyPage } = await vite.ssrLoadModule(
    "/src/pages/RentalPolicyPage.tsx",
  );
  await act(async () =>
    root.render(
      createElement(MemoryRouter, null, createElement(RentalPolicyPage)),
    ),
  );
  const document = dom.window.document;
  assert.match(
    document.querySelector("h1")!.textContent!,
    /Rental Protection.*Records Policy/,
  );
  const content = document.querySelector("article")!.textContent!;
  assert.match(content, /24 calendar months/);
  assert.match(content, /Nibash contractual protection/);
  assert.match(content, /one month/);
  assert.match(content, /electronic payment acknowledgment/);
  assert.match(content, /Submitted manually — unverified/);
  assert.match(
    document.querySelector("header")!.textContent!,
    /effective upon publication/i,
  );
  for (const section of ["30640", "30641", "30643", "30646", "30648"]) {
    assert.ok(
      document.querySelector(
        `a[href="https://bdlaws.minlaw.gov.bd/act-748/section-${section}.html"]`,
      ),
    );
  }
  assert.ok(
    document.querySelector(
      'a[href="https://bdlaws.minlaw.gov.bd/act-print-48/section-print-16322.html"]',
    ),
  );
  for (const link of document.querySelectorAll(
    'nav[aria-label="Policy contents"] a',
  )) {
    assert.ok(document.getElementById(link.getAttribute("href")!.slice(1)));
  }
});

test("registration links the readable policy in a new tab and requires an explicit unchecked acknowledgment", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/register",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
  });
  const { RegisterPage } = await vite.ssrLoadModule(
    "/src/components/RegisterPage.tsx",
  );
  const { AuthProvider } = await vite.ssrLoadModule(
    "/src/context/AuthContext.tsx",
  );
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(AuthProvider, null, createElement(RegisterPage)),
      ),
    ),
  );
  const document = dom.window.document;
  const checkbox = document.querySelector<HTMLInputElement>("#reg-terms")!;
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.required, true);
  assert.equal(checkbox.checkValidity(), false);
  const link = document.querySelector<HTMLAnchorElement>(
    'label[for="reg-terms"] a',
  )!;
  assert.equal(link.getAttribute("href"), "/policies/rental-protection");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /noopener/);
  assert.ok(!document.body.textContent!.includes("Privacy Policy"));
  await act(async () => checkbox.click());
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.checkValidity(), true);
});
