import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("web/registry.js", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("function constrainRegistryName"), source.indexOf("function registryTab"));

function input(value = "") {
  return {
    value, selectionStart: value.length, selectionEnd: value.length, events: {},
    addEventListener(type, handler) { (this.events[type] ??= []).push(handler); },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    fire(type) { for (const handler of this.events[type] || []) handler(); },
  };
}

function setup() {
  const context = {};
  vm.runInNewContext(`${helper}\nglobalThis.constrain = constrainRegistryName;`, context);
  return context.constrain;
}

test("registry entry names lowercase letters and reject prohibited characters", () => {
  const field = input("Mr Anderson_42!@/Agent");
  setup()(field);
  assert.equal(field.value, "mranderson42agent");
  assert.equal(field.selectionStart, field.value.length);
});

test("registry group paths keep slashes and preserve the caret through normalization", () => {
  const field = input("Team One/Sub_Group");
  field.selectionStart = field.selectionEnd = 8;
  setup()(field, true);
  assert.equal(field.value, "teamone/subgroup");
  assert.equal(field.selectionStart, 7);
});

test("registry names normalize paste and wait for IME composition to finish", () => {
  const field = input("valid");
  setup()(field);
  field.fire("compositionstart");
  field.value = "validÉ";
  field.selectionStart = field.selectionEnd = field.value.length;
  field.fire("input");
  assert.equal(field.value, "validÉ", "composition text is not changed mid-entry");
  field.fire("compositionend");
  assert.equal(field.value, "valid");

  field.value = "New Name!?";
  field.selectionStart = field.selectionEnd = field.value.length;
  field.fire("input");
  assert.equal(field.value, "newname");
});
