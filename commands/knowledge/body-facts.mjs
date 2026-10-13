import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const hash = text => createHash("sha256").update(text).digest("hex");

function label(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (["MethodDefinition", "Property", "PropertyDefinition"].includes(parent?.type) && !parent.computed) {
    return parent.key.name ?? String(parent.key.value);
  }
  return `anonymous@${node.loc.start.line}:${node.loc.start.column}`;
}

function primitive(node) {
  if (node?.type === "Literal" && !node.regex && !node.bigint &&
      (typeof node.value !== "number" || Number.isFinite(node.value)) &&
      (node.value === null || ["boolean", "number", "string"].includes(typeof node.value))) {
    return { expressionKind: "primitive-literal", value: node.value };
  }
  if (node?.type === "UnaryExpression" && node.operator === "void" &&
      node.argument.type === "Literal" && !node.argument.regex && !node.argument.bigint) {
    return { expressionKind: "undefined", valueLabel: "undefined" };
  }
  return null;
}

// These rules describe the whole local body. They do not establish runtime callers.
function bodyContract(node, parent, source) {
  if (node.generator || (parent?.type === "MethodDefinition" && parent.kind === "constructor")) return null;
  if (node.params.some(parameter => parameter.type !== "Identifier")) return null;
  let expression;
  if (node.body.type !== "BlockStatement") expression = node.body;
  else {
    const statements = node.body.body.filter(statement => !statement.directive);
    if (statements.length === 0 || (statements.length === 1 && statements[0].type === "ReturnStatement" && !statements[0].argument)) {
      return { rule: "empty-or-bare-return", explanation: "After parameter binding succeeds, the local body completes with undefined.",
        return: { expressionKind: "undefined", valueLabel: "undefined" }, async: node.async,
        completion: node.async ? "The async function promise fulfills with undefined after this body completes." : "This is the body return value; constructor invocation can ignore it." };
    }
    if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return null;
    expression = statements[0].argument;
  }
  const value = primitive(expression);
  if (value) return { rule: "return-primitive", explanation: `After parameter binding succeeds, the local body returns ${source.slice(...expression.range)}.`,
    return: value, async: node.async,
    completion: node.async ? "The async function promise fulfills with this primitive value after the return." : "This is the body return value; constructor invocation can ignore it." };
  if (!node.async && expression.type === "Identifier" && node.params.some(parameter => parameter.name === expression.name)) {
    return { rule: "return-bound-parameter", explanation: `Returns the bound parameter ${expression.name} without calling it or reading one of its properties.`,
      return: { expressionKind: "bound-parameter", parameter: expression.name }, async: false,
      completion: "This is the body return value. The caller can supply any value; constructor invocation can ignore it." };
  }
  return null;
}

export function extractDirectBodyFacts(source, { repository, revision, path, role = "unknown" } = {}) {
  if (path?.startsWith("suite/")) return { status: "excluded-suite", facts: [], functions: 0 };
  let tree, sourceType, parseError;
  for (const mode of ["module", "script"]) {
    try {
      tree = espree.parse(source, { ecmaVersion: "latest", sourceType: mode, loc: true, range: true,
        ecmaFeatures: { globalReturn: true, jsx: true } });
      sourceType = mode;
      break;
    } catch (error) { parseError = error.message; }
  }
  if (!tree) return { status: "parse-failed", parseError, facts: [], functions: 0 };
  const parents = new Map(), nodes = [], facts = [], factByNode = new Map();
  const pending = [[tree, null, "top-level"]];
  while (pending.length) {
    const [node, parent, enclosing] = pending.pop();
    parents.set(node, parent);
    let childEnclosing = enclosing;
    if (functionTypes.has(node.type)) {
      nodes.push(node);
      const symbol = label(node, parent);
      childEnclosing = `${symbol}@${node.loc.start.line}-${node.loc.end.line}`;
      const contract = bodyContract(node, parent, source);
      if (contract) {
        const anchor = { repository, revision, path, start: node.loc.start.line, end: node.loc.end.line,
          column: node.loc.start.column, symbol, symbolBasis: node.id?.name ? "written-function-name" : "syntax-navigation-label" };
        const fact = { id: hash(JSON.stringify([anchor, node.range, contract.rule])), anchor,
          language: "JavaScript", role, sourceType, enclosing, syntaxKind: node.type,
          functionRangeUtf16: node.range, bodyRangeUtf16: node.body.range,
          bodyHash: hash(source.slice(...node.body.range)), bodyBytes: Buffer.byteLength(source.slice(...node.body.range)),
          contract, lexicalCallSites: [], interpretation: "deterministic-whole-local-body-contract",
          relationshipCoverage: "local lexical calls only; member calls, exports, runtime owners and cross-file consumers remain unresolved",
          limits: "No execution or product test result. Parameter entry, caller contracts, method receivers and constructor use require contextual analysis." };
        facts.push(fact); factByNode.set(node, fact);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "range", "parent"].includes(key) || !value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) pending.push([child, node, childEnclosing]);
      } else if (value.type) pending.push([value, node, childEnclosing]);
    }
  }
  let scopeError;
  try {
    const manager = eslintScope.analyze(tree, { ecmaVersion: 2024, sourceType, optimistic: false, ignoreEval: false });
    for (const scope of manager.scopes) {
      for (const reference of scope.references) {
        const call = parents.get(reference.identifier);
        if (!reference.resolved || reference.tainted || call?.type !== "CallExpression" || call.callee !== reference.identifier) continue;
        const targets = reference.resolved.defs.map(def => def.node?.type === "VariableDeclarator" ? def.node.init : def.node)
          .filter(node => factByNode.has(node));
        if (targets.length !== 1 || reference.resolved.references.some(ref => ref.isWrite() && !ref.init)) continue;
        const fact = factByNode.get(targets[0]);
        const consumer = parents.get(call);
        fact.lexicalCallSites.push({ path, start: call.loc.start.line, end: call.loc.end.line,
          writtenCallee: reference.identifier.name, consumerSyntax: consumer?.type ?? "unknown",
          basis: "lexical-binding-resolution", condition: "The written call must be reached at runtime; this is not an execution result." });
      }
    }
  } catch (error) { scopeError = error.message; }
  facts.sort((a, b) => a.anchor.start - b.anchor.start || a.anchor.column - b.anchor.column);
  return { status: "parsed", sourceType, parser: `espree ${espree.version}`, bindingResolver: `eslint-scope ${eslintScope.version}`,
    sourceHash: hash(source), sourceBytes: Buffer.byteLength(source), functions: nodes.length, facts,
    ...(scopeError ? { scopeError } : {}) };
}
