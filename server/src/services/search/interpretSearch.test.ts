import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../../db/pool.js";
import { interpretSearch, validateInterpretation, parseAmounts, redactSearchInput, searchOutputJsonSchema, modelInterpretationSchema } from "./interpretSearch.js";

const catalog = { areas: [{ id: 2, name: "Dhanmondi" }, { id: 4, name: "Gulshan" }], amenities: [{ name: "Elevator" }, { name: "Garage" }] };
const constraint = (field: string, value: string, evidence: string, mandatory = true) => ({ field, value, evidence, mandatory });
const output = (constraints: unknown[] = [], unsupported: unknown[] = []) => ({ constraints, unsupported });

// Hand-authored expected results; model output here is a fixture, not an accuracy evaluation.
for (const [query, area, beds, budget, lift] of [
  ["Need exactly 3 bedrooms in Dhanmondi under 30k with lift", "Dhanmondi", "3 bedrooms", "30k", "lift"],
  ["ধানমন্ডিতে ঠিক ৩ বেডরুম ৩০ হাজার টাকার মধ্যে লিফট চাই", "ধানমন্ডি", "৩ বেডরুম", "৩০ হাজার", "লিফট"],
  ["Dhanmondi te exactly 3 bedroom 30 hajar er moddhe lift chai", "Dhanmondi", "3 bedroom", "30 hajar", "lift"],
]) {
  test(`grounded multilingual expected filters: ${query}`, () => {
    const result = validateInterpretation(query, output([
      constraint("area", "Dhanmondi", area), constraint("bedrooms", "3", beds),
      constraint("maxRent", "30000", budget), constraint("amenity", "Elevator", lift),
    ]), catalog);
    assert.deepEqual(result.filters, { areaId: 2, areaName: "Dhanmondi", bedrooms: 3, maxRent: 30000, amenityNames: ["Elevator"] });
    assert.deepEqual(result.unsupported, []);
  });
}

for (const [text, expected] of [["৩০ হাজার", 30000], ["30k", 30000], ["30 hajar", 30000], ["30 thousand", 30000], ["1.5 lakh", 150000], ["BDT 25,000", 25000], ["৳২৫০০০", 25000]] as const) {
  test(`amount ${text}`, () => assert.deepEqual(parseAmounts(text), [expected]));
}

test("minimum bedrooms and two-sided rent remain distinct", () => {
  const r = validateInterpretation("at least 3 bedrooms between 20k and 30k", output([
    constraint("minBedrooms", "3", "at least 3 bedrooms"), constraint("minRent", "20000", "20k"), constraint("maxRent", "30000", "30k"),
  ]), catalog);
  assert.deepEqual(r.filters, { minBedrooms: 3, minRent: 20000, maxRent: 30000 });
});

test("Bangla and Banglish range separators make the following amount the upper bound", () => {
  for (const [query, lower, upper] of [
    ["২০ হাজার থেকে ৪০ হাজার টাকার মধ্যে", "২০ হাজার", "৪০ হাজার"],
    ["20 hajar theke 40k rent", "20 hajar", "40k"],
  ]) {
    const result = validateInterpretation(query, output([
      constraint("minRent", "20000", lower), constraint("maxRent", "40000", upper),
    ]), catalog);
    assert.deepEqual(result.filters, { minRent: 20000, maxRent: 40000 });
    assert.deepEqual(result.unsupported, []);
  }
});

test("equivalent Bangla and ASCII numeral evidence preserves the stated budget only", () => {
  const query = "3 bedrooms in Dhanmondi under ৳২৫০০০";
  const result = validateInterpretation(query, output([constraint("maxRent", "25000", "৳25000")]), catalog);
  assert.deepEqual(result.filters, { maxRent: 25000 });
  assert.deepEqual(result.unsupported, []);
  const invented = validateInterpretation(query, output([constraint("maxRent", "35000", "৳35000")]), catalog);
  assert.deepEqual(invented.filters, {});
  assert.ok(invented.unsupported.some(item => item.mandatory));
});

test("area aliases, typo tolerance and unavailable amenities", () => {
  for (const alias of ["dhanmondy", "ধানমন্ডি", "ধানমন্ডিতে", "Dhanmondi te", "Dhanmondi"]) {
    const r = validateInterpretation(alias, output([constraint("area", "Dhanmondi", alias)]), catalog);
    assert.equal(r.filters.areaId, 2);
  }
  const r = validateInterpretation("helipad in Atlantis", output([constraint("amenity", "helipad", "helipad"), constraint("area", "Atlantis", "Atlantis")]), catalog);
  assert.equal(r.unsupported.length, 2);
  assert.deepEqual(r.filters, {});
});

test("provider schema avoids the bounded-array enum rejection while local validation retains its limit", () => {
  assert.equal(searchOutputJsonSchema.properties.constraints.maxItems, undefined);
  assert.equal(searchOutputJsonSchema.properties.unsupported.maxItems, undefined);
  assert.ok(searchOutputJsonSchema.properties.constraints.items.properties.field.enum.includes("maxRent"));
  assert.equal(modelInterpretationSchema.safeParse(output(Array.from({ length: 33 }, () => constraint("bedrooms", "3", "3 bedrooms")))).success, false);
});

test("preferences are never applied as mandatory filters; transit remains unsupported", () => {
  const r = validateInterpretation("prefer parking near metro", output([constraint("amenity", "Garage", "parking", false)], [{ evidence: "near metro", mandatory: true, reason: "Transit distances are not searchable" }]), catalog);
  assert.deepEqual(r.filters, {});
  assert.deepEqual(r.preferences, ["parking"]);
  assert.equal(r.unsupported[0].mandatory, true);
});

test("hallucinated prices, evidence, locations and malformed output cannot become filters", () => {
  assert.throws(() => validateInterpretation("in Dhanmondi", { sql: "DROP TABLE listings" }, catalog));
  const r = validateInterpretation("in Gulshan under 30k", output([
    constraint("area", "Dhanmondi", "Gulshan"), constraint("maxRent", "50000", "30k"), constraint("bedrooms", "4", "4 bedrooms"),
  ]), catalog);
  assert.deepEqual(r.filters, {});
  assert.equal(r.unsupported.length, 3);
});

test("contradictory requirements are explicit", () => {
  const r = validateInterpretation("exactly 2 bedrooms and at least 3 bedrooms", output([constraint("bedrooms", "2", "2 bedrooms"), constraint("minBedrooms", "3", "3 bedrooms")]), catalog);
  assert.ok(r.unsupported.some(x => x.mandatory && /conflict/i.test(x.reason)));
});

test("model cannot downgrade mandatory constraints or reverse comparison and pet policy", () => {
  const lift = validateInterpretation("must have lift", output([constraint("amenity", "Elevator", "lift", false)]), catalog);
  assert.deepEqual(lift.filters.amenityNames, ["Elevator"]);
  for (const [query, item] of [
    ["exactly 3 bedrooms", constraint("minBedrooms", "3", "3 bedrooms")],
    ["at least 3 bedrooms", constraint("bedrooms", "3", "3 bedrooms")],
    ["rent under 30k", constraint("minRent", "30000", "30k")],
    ["rent under 30k", constraint("minRent", "30000", "under 30k")],
    ["rent above 20k", constraint("maxRent", "20000", "20k")],
    ["rent above 20k", constraint("maxRent", "20000", "above 20k")],
    ["must not have lift", constraint("amenity", "Elevator", "lift")],
    ["pets must be allowed", constraint("pets", "false", "pets must be allowed")],
    ["no pets allowed", constraint("pets", "true", "no pets allowed")],
  ] as const) {
    const r = validateInterpretation(query, output([item]), catalog);
    assert.deepEqual(r.filters, {}, query);
    assert.ok(r.unsupported.some(x => x.mandatory), query);
  }
});

test("input and sensitive data handling", async () => {
  await assert.rejects(() => interpretSearch(" "), /query/i);
  await assert.rejects(() => interpretSearch("x".repeat(601)), /query/i);
  const redacted = redactSearchInput("2 beds email a@b.com phone 01712345678 Bearer abc.def.ghi");
  assert.ok(!redacted.includes("a@b.com") && !redacted.includes("01712345678") && !redacted.includes("abc.def.ghi"));
  assert.ok(!redactSearchInput("ফোন ০১৭১২৩৪৫৬৭৮").includes("০১৭১২৩৪৫৬৭৮"));
});

test("disabled, malformed model output, timeout and API failures return explicit fallback without filters", async t => {
  const old = { enabled: process.env.SEARCH_AI_ENABLED, key: process.env.SEARCH_AI_API_KEY, model: process.env.SEARCH_AI_MODEL };
  t.after(() => { for (const [key, value] of [["SEARCH_AI_ENABLED", old.enabled], ["SEARCH_AI_API_KEY", old.key], ["SEARCH_AI_MODEL", old.model]]) value === undefined ? delete process.env[key!] : process.env[key!] = value; });
  process.env.SEARCH_AI_ENABLED = "false";
  const off = await interpretSearch("3 bedrooms", { catalog });
  assert.equal(off.status, "fallback"); assert.deepEqual(off.filters, {});
  process.env.SEARCH_AI_ENABLED = "true"; process.env.SEARCH_AI_API_KEY = "test"; process.env.SEARCH_AI_MODEL = "test-model";
  for (const provider of [async () => ({ invalid: true }), async () => { throw new Error("provider secret"); }, async () => { throw new DOMException("timeout", "TimeoutError"); }]) {
    const r = await interpretSearch("3 bedrooms", { catalog, provider });
    assert.equal(r.status, "fallback"); assert.deepEqual(r.filters, {});
    assert.ok(!JSON.stringify(r).includes("provider secret"));
  }
});

test("deadline bounds a hung provider and hung catalog acquisition", async t => {
  const keys = ["SEARCH_AI_ENABLED", "SEARCH_AI_MODEL", "SEARCH_AI_API_KEY", "SEARCH_AI_TIMEOUT_MS"];
  const previous = keys.map(key => process.env[key]);
  const originalQuery = pool.query;
  t.after(() => { pool.query = originalQuery; keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]); });
  process.env.SEARCH_AI_ENABLED = "true"; process.env.SEARCH_AI_MODEL = "test";
  process.env.SEARCH_AI_API_KEY = "synthetic"; process.env.SEARCH_AI_TIMEOUT_MS = "100";
  let started = performance.now();
  const provider = await interpretSearch("3 bedrooms", { catalog, provider: () => new Promise(() => {}) });
  assert.equal(provider.status, "fallback"); assert.ok(performance.now() - started < 1000);
  pool.query = (() => new Promise(() => {})) as typeof pool.query;
  started = performance.now();
  const db = await interpretSearch("3 bedrooms");
  assert.equal(db.status, "fallback"); assert.ok(performance.now() - started < 1000);
});

test("provider adapter constrains schema, isolates model config, redacts input and fails closed on bad HTTP/JSON", async t => {
  const keys = ["SEARCH_AI_ENABLED", "SEARCH_AI_MODEL", "SEARCH_AI_API_KEY", "GEMINI_MODEL"];
  const previous = keys.map(key => process.env[key]); const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]); });
  process.env.SEARCH_AI_ENABLED = "true"; process.env.SEARCH_AI_MODEL = "search-model";
  process.env.SEARCH_AI_API_KEY = "synthetic"; process.env.GEMINI_MODEL = "document-model";
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output([constraint("bedrooms", "3", "3 bedrooms")])) }] } }] }));
  }) as typeof fetch;
  const r = await interpretSearch("3 bedrooms contact a@b.com ফোন ০১৭১২৩৪৫৬৭৮ Bearer secret-token", { catalog });
  assert.equal(r.status, "interpreted"); assert.deepEqual(r.filters, { bedrooms: 3 });
  assert.ok(request!.url.includes("search-model") && !request!.url.includes("document-model"));
  const body = String(request!.init!.body);
  assert.ok(!body.includes("a@b.com") && !body.includes("০১৭১২৩৪৫৬৭৮") && !body.includes("secret-token"));
  assert.equal(JSON.parse(body).generationConfig.responseJsonSchema.additionalProperties, false);
  for (const response of [new Response("provider content", { status: 429 }), new Response("not json"),
    new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] })),
    new Response(JSON.stringify({ candidates: [] }))]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    assert.equal((await interpretSearch("3 bedrooms", { catalog })).status, "fallback");
  }
});
