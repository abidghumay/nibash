import assert from "node:assert/strict";
import test from "node:test";
import { getAreaIdByName, getAreaName } from "../src/utils/areaLookup";

const areas = [{ id: 44, name: "Gulshan", city: "Dhaka" }, { id: 92, name: "Gulshan 2", city: "Dhaka" },
  { id: 83, name: "Shyamoli", city: "Dhaka" }];

test("area lookup uses catalog identity and never guesses from a substring or whitespace", () => {
  assert.equal(getAreaIdByName("   ", areas), null);
  assert.equal(getAreaIdByName("gul", areas), null);
  assert.equal(getAreaIdByName(" Gulshan 2 ", areas), 92);
  assert.equal(getAreaIdByName("SHYAMOLI", areas), 83);
  assert.equal(getAreaName(44, areas), "Gulshan");
  assert.equal(getAreaName(999, areas), "Area #999");
  assert.equal(getAreaName(null, areas), "Dhaka");
});
