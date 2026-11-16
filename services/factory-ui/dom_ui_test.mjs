import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const app = fs.readFileSync(new URL("web/app.js", import.meta.url), "utf8");
const helper = app.slice(app.indexOf("function h("), app.indexOf("// createTree"));
test("DOM helper sets datalist through attribute without assigning readonly input.list", () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.attributes = {}; this.children = []; this.value = ""; }
    get list() { return null; }
    setAttribute(k, v) { this.attributes[k] = v; }
    append(v) { this.children.push(v); }
  }
  const ctx = { document: { createElement: (tag) => new Element(tag) }, Node: Element };
  vm.runInNewContext(`"use strict"; ${helper}`, ctx);
  for (const name of ["workflow", "agent"]) {
    const field = ctx.h("input", { list: `evaluation-${name}-options`, value: "test" });
    assert.equal(field.attributes.list, `evaluation-${name}-options`);
    assert.equal(field.value, "test");
  }
});
