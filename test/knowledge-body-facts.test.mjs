import test from "node:test";
import assert from "node:assert/strict";
import { extractDirectBodyFacts } from "../commands/knowledge/body-facts.mjs";

const extract = source => extractDirectBodyFacts(source, { repository: "example", revision: "a".repeat(40), path: "module.mjs" });

test("body facts reject effects before a return", () => {
  const result = extract("function read() { changeState(); return 1; } function constant() { return 1; }");
  assert.equal(result.functions, 2, "The parser should account for both bodies.");
  assert.deepEqual(result.facts.map(fact => fact.anchor.symbol), ["constant"], "Only the body with no preceding action should receive a constant contract.");
});

test("async parameter returns require thenable analysis", () => {
  const result = extract("const identity = x => x; const adopt = async x => x; const done = async () => 4;");
  assert.deepEqual(result.facts.map(fact => fact.anchor.symbol), ["identity", "done"], "An async parameter return should remain outside the primitive completion rule.");
  assert.equal(result.facts[1].contract.async, true, "The primitive async contract should retain promise completion.");
});

test("defaults destructuring constructors and generators remain contextual", () => {
  const result = extract("function withDefault(x = setup()) { return 1; } function destructure({x}) { return 1; } function* generate() { return 1; } class C { constructor() {} get constant() { return null; } }");
  assert.deepEqual(result.facts.map(fact => fact.anchor.symbol), ["constant"], "Parameter actions, constructors and generators should remain outside the narrow rule.");
});

test("nested bodies do not certify the enclosing body", () => {
  const result = extract("function outer() { function inner() { return false; } return inner(); }");
  assert.equal(result.functions, 2, "Nested and outer functions should be counted separately.");
  assert.equal(result.facts.length, 1, "Only the inner literal-return body should receive a contract.");
  assert.equal(result.facts[0].lexicalCallSites.length, 1, "The lexical inner call should have a resolved source site.");
});

test("same spelling does not establish the target", () => {
  const result = extract("function same() { return 1; } function caller(same) { return same(); } object.same(); same();");
  const fact = result.facts.find(fact => fact.anchor.symbol === "same");
  assert.equal(fact.lexicalCallSites.length, 1, "Shadowed and member calls should not be assigned to the named declaration.");
});

test("assignment makes a lexical target uncertain", () => {
  const result = extract("let replaceable = () => 1; replaceable = another; replaceable();");
  assert.equal(result.facts[0].lexicalCallSites.length, 0, "A reassigned function binding should not have a proven call target.");
});

test("directives and bare returns retain undefined completion", () => {
  const result = extract('async function empty() { "use strict"; return; }');
  assert.equal(result.facts[0].contract.return.valueLabel, "undefined", "A bare return should retain undefined completion.");
});

test("excluded and invalid files keep explicit states", () => {
  assert.equal(extractDirectBodyFacts("", { path: "suite/module.js" }).status, "excluded-suite", "Suite should be excluded before analysis.");
  assert.equal(extract("function broken(").status, "parse-failed", "Invalid syntax should retain an extraction failure.");
});

test("numeric overflow cannot be serialized as null", () => {
  const result = extract("function infinite() { return 1e999; } function finite() { return 4; }");
  assert.deepEqual(result.facts.map(fact => fact.anchor.symbol), ["finite"], "A non-finite literal should remain outside JSON-valued primitive contracts.");
});

test("dynamic scopes do not establish lexical call targets", () => {
  const evaluated = extract('function constant() { return 1; } eval("constant = other"); constant();');
  assert.equal(evaluated.facts[0].lexicalCallSites.length, 0, "Direct eval should prevent a proved lexical call target.");
  const scoped = extract('function constant() { return 1; } with (object) { constant(); }');
  assert.equal(scoped.facts[0].lexicalCallSites.length, 0, "A with scope should prevent a proved lexical call target.");
});
