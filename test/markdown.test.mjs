import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../commands/graph/client/markdown.js";

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.value = String(value);
  }

  get textContent() {
    return this.value;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  set textContent(value) {
    this.children = [new FakeText(value)];
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}

function getElements(node, tagName) {
  return node.children.flatMap((child) => [
    ...(child.tagName === tagName ? [child] : []),
    ...(child.children ? getElements(child, tagName) : []),
  ]);
}

test("renderMarkdown renders description markup without unsafe links", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const root = new FakeElement("div");

  globalThis.window = { location: { origin: "https://console.example" } };
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => new FakeText(value),
  };

  try {
    renderMarkdown(root, [
      "# Description heading",
      "",
      "A **strong** word, `inline code`, and [safe link](https://example.com).",
      "",
      "- First item",
      "- Second item",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| One | Two |",
      "",
      "[unsafe](javascript:alert(1))",
    ].join("\n"));
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }

  assert.equal(getElements(root, "h1")[0].textContent, "Description heading");
  assert.equal(getElements(root, "strong")[0].textContent, "strong");
  assert.equal(getElements(root, "code")[0].textContent, "inline code");
  assert.equal(getElements(root, "a")[0].href, "https://example.com/");
  assert.equal(getElements(root, "li").length, 2);
  assert.equal(getElements(root, "th").length, 2);
  assert.equal(getElements(root, "td").length, 2);
  assert.equal(getElements(root, "a").length, 1);
  assert.match(root.textContent, /\[unsafe\]\(javascript:alert\(1\)\)/);
});

test("renderMarkdown renders bare URLs without recursively parsing link labels", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const root = new FakeElement("div");

  globalThis.window = { location: { origin: "https://console.example.com" } };
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => new FakeText(value),
  };

  try {
    renderMarkdown(root, "See https://example.com/review for the latest status.");

    const links = getElements(root, "a");

    assert.equal(links.length, 1);
    assert.equal(links[0].href, "https://example.com/review");
    assert.equal(links[0].textContent, "https://example.com/review");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("renderMarkdown keeps continued lines inside list items", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const root = new FakeElement("div");

  globalThis.window = { location: { origin: "https://console.example" } };
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (value) => new FakeText(value),
  };

  try {
    renderMarkdown(root, [
      "Acceptance criteria:",
      "",
      "- Use the loaded data. If",
      "recurrence-id identifies one occurrence, use its values.",
      "- Copy dates and times",
      "  and **timezone** values.",
      "",
      "Required implementation details:",
      "",
      "3. First numbered item",
      "with a continued line.",
      "4. Second numbered item",
      "## Next section",
      "Separate paragraph.",
    ].join("\n"));

    assert.deepEqual(root.children.map((child) => child.tagName), [
      "p", "ul", "p", "ol", "h2", "p",
    ]);
    assert.deepEqual(getElements(root, "li").map((item) => item.textContent), [
      "Use the loaded data. If recurrence-id identifies one occurrence, use its values.",
      "Copy dates and times and timezone values.",
      "First numbered item with a continued line.",
      "Second numbered item",
    ]);
    assert.equal(getElements(root, "strong")[0].textContent, "timezone");
    assert.equal(getElements(root, "ol")[0].start, 3);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
