import assert from "node:assert/strict";
import test from "node:test";
import {
  minorUnits,
  validateVerification,
  sandboxConfig,
} from "./shurjoPaySandbox.js";

test("BDT comparison is exact, accepts provider zero padding, rejects fractional paisa", () => {
  assert.equal(minorUnits("90071992547409.91"), 9007199254740991n);
  assert.equal(minorUnits("10.0000"), 1000n);
  for (const value of ["1.001", "-1", "1e2", "NaN", "Infinity"])
    assert.throws(() => minorUnits(value));
});
test("sandbox requires explicit non-production opt-in", () => {
  assert.equal(sandboxConfig({}).enabled, false);
  assert.throws(() =>
    sandboxConfig({ NODE_ENV: "production", PAYMENT_SANDBOX_ENABLED: "true" }),
  );
  assert.equal(
    sandboxConfig({
      NODE_ENV: "development",
      PAYMENT_SANDBOX_ENABLED: "true",
      PAYMENT_SANDBOX_PROVIDER: "simulated",
    }).provider,
    "simulated",
  );
  assert.throws(() =>
    sandboxConfig({
      NODE_ENV: "development",
      PAYMENT_SANDBOX_ENABLED: "true",
      PAYMENT_SANDBOX_PROVIDER: "live",
    }),
  );
});
test("provider verification binds transaction, merchant order, BDT, amount and status", () => {
  const attempt = {
    id: "a",
    provider_order_id: "sp1",
    merchant_order_id: "nibash1",
    amount: "100.00",
    payment_id: 5,
  };
  const evidence = {
    order_id: "sp1",
    customer_order_id: "nibash1",
    amount: "100.0000",
    currency: "BDT",
    value1: "5",
    value2: "a",
    sp_code: "1000",
  };
  assert.equal(validateVerification(attempt, evidence), "succeeded");
  for (const [key, value] of Object.entries({
    order_id: "forged",
    customer_order_id: "other",
    amount: "101",
    currency: "USD",
    value1: "6",
    value2: "other",
  })) {
    assert.throws(
      () => validateVerification(attempt, { ...evidence, [key]: value }),
      /mismatch/i,
    );
  }
  assert.equal(
    validateVerification(attempt, { ...evidence, sp_code: "1001" }),
    "failed",
  );
  assert.equal(
    validateVerification(attempt, { ...evidence, sp_code: "1002" }),
    "cancelled",
  );
  assert.equal(
    validateVerification(attempt, { ...evidence, sp_code: "9999" }),
    "pending",
  );
});
