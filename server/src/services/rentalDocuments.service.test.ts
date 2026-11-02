import assert from "node:assert/strict";
import test from "node:test";
import { formatRentalField } from "./rentalDocuments.service.js";
test("document formatting keeps outstanding money numeric even though its label contains at", () => {
  assert.equal(
    formatRentalField("Outstanding at this event (BDT)", "15000"),
    "15000",
  );
  assert.equal(
    formatRentalField("Amount actually received (BDT)", "5000"),
    "5000",
  );
  assert.match(
    formatRentalField("Confirmed at", "2026-11-02T20:00:00Z"),
    /03\/11\/2026, 02:00:00 \(Asia\/Dhaka\)/,
  );
  assert.equal(
    formatRentalField("Tenant acceptance audit", null),
    "Not recorded",
  );
});
