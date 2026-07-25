import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDefaultValue, formatOptionExample } from "../commands/readme.mjs";

test("formatDefaultValue omits undefined defaults", () => {
  assert.equal(formatDefaultValue(undefined), "");
  assert.equal(formatDefaultValue("auto"), "auto");
});

test("formatOptionExample uses clearer values for booleans and required options", () => {
  assert.equal(formatOptionExample("try", { name: "query" }), "tb try --query=<value>");
  assert.equal(formatOptionExample("try", { name: "comment", defaultValue: "false" }), "tb try --comment");
  assert.equal(formatOptionExample("create", { name: "update", defaultValue: "true" }), "tb create --update=false");
  assert.equal(formatOptionExample("try", { name: "selector", defaultValue: "auto" }), "tb try --selector=auto");
});
