import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

test("simulated completion is clearly labeled and refreshes balances when panel reopens", async (t) => {
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
      attempts: [
        {
          id: "test",
          state: "succeeded",
          amount: "100",
          provider: "simulated",
          checkout_url: null,
          last_error: null,
        },
      ],
    })) as typeof fetch;
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { SandboxPayment } = await vite.ssrLoadModule(
    "/src/components/SandboxPayment.tsx",
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    await vite.close();
    dom.window.close();
  });
  let refreshes = 0;
  await act(async () =>
    root.render(
      createElement(SandboxPayment, {
        paymentId: 1,
        isTenant: true,
        payable: false,
        provider: "simulated",
        onChanged: () => refreshes++,
      }),
    ),
  );
  assert.equal(refreshes, 1);
  assert.match(
    dom.window.document.body.textContent!,
    /Simulated payment — no real money transferred/,
  );
  assert.match(dom.window.document.body.textContent!, /Simulation confirmed/);
  assert.doesNotMatch(
    dom.window.document.body.textContent!,
    /Verified by sandbox/,
  );
  assert.equal(dom.window.document.querySelectorAll("a").length, 0);
});
