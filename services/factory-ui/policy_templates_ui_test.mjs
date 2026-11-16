import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("web/registry.js", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("const policySegment"), source.indexOf("function registryTab"));

function setup() {
  const nodes = [];
  let dialog;
  const h = (tag, props = {}, ...children) => {
    const node = {
      tag, ...props, children: children.flat().filter((item) => item !== null && item !== undefined && item !== false),
      value: props.value || "", disabled: !!props.disabled,
      replaceChildren(...items) { this.children = items.flat(); },
    };
    nodes.push(node);
    return node;
  };
  const context = {
    h,
    Event: class { constructor(type) { this.type = type; } },
    setTextViewMode(mode) { context.mode = mode; },
    openDialog(config) {
      dialog = { config, closed: false, close() { this.closed = true; } };
      return dialog;
    },
  };
  vm.runInNewContext(`${helpers}\nglobalThis.policyUI = { policyReferences, insertPolicyReference, validatePolicyPrompt, openPolicyReferencePicker, runExclusive };`, context);
  return { ...context.policyUI, context, nodes, get dialog() { return dialog; } };
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };

function textarea(value, start, end = start) {
  return {
    value, selectionStart: start, selectionEnd: end, inputs: 0,
    setRangeText(text, from, to) { this.value = this.value.slice(0, from) + text + this.value.slice(to); this.selectionStart = this.selectionEnd = from + text.length; },
    dispatchEvent(event) { if (event.type === "input") this.inputs++; },
  };
}

test("policy references insert at the captured cursor or replace its selection", async () => {
  const ui = setup();
  const area = textarea("alpha SELECT omega", 6, 12);
  let inserted = 0;
  ui.openPolicyReferencePicker(area, { start: 6, end: 12 }, async () => ["security/base", "quality"], () => inserted++);
  await settle();
  const select = ui.nodes.find((node) => node.tag === "select");
  const add = ui.nodes.find((node) => node.tag === "button" && node.children.includes("Add policy"));
  select.value = "security/base";
  add.onclick();
  assert.equal(area.value, "alpha {{policy::security/base}} omega");
  assert.equal(area.inputs, 1, "the registry dirty-state input path runs");
  assert.equal(ui.context.mode, "text");
  assert.equal(inserted, 1);
  assert.equal(ui.dialog.closed, true);
});

test("canceling the policy picker never changes the prompt", async () => {
  const ui = setup();
  const area = textarea("unchanged", 4);
  ui.openPolicyReferencePicker(area, { start: 4, end: 4 }, async () => ["quality"]);
  await settle();
  ui.nodes.find((node) => node.tag === "button" && node.children.includes("Cancel")).onclick();
  assert.equal(area.value, "unchanged");
  assert.equal(area.inputs, 0);
  assert.equal(ui.dialog.closed, true);
});

test("save validation deduplicates policy fetches and rejects missing or malformed references", async () => {
  const { policyReferences, validatePolicyPrompt } = setup();
  assert.deepEqual(Array.from(policyReferences("{{policy::quality}} x {{policy::quality}} {{policy::security/base}}")), ["quality", "security/base"]);
  const fetched = [];
  await validatePolicyPrompt("{{policy::quality}} {{policy::quality}}", async (id) => fetched.push(id));
  assert.deepEqual(fetched, ["quality"]);
  await assert.rejects(validatePolicyPrompt("{{policy::missing}}", async () => { const error = new Error("not found"); error.status = 404; throw error; }), /Required policy missing does not exist/);
  await assert.rejects(validatePolicyPrompt("{{policy::quality}}", async () => { const error = new Error("service unavailable"); error.status = 503; throw error; }), /Cannot validate required policy quality: service unavailable/);
  assert.throws(() => policyReferences("{{policy::Not Valid}}"), /Invalid policy reference/);
  assert.throws(() => policyReferences("{{policy::quality"), /missing }}/);
});

test("agent policy validation uses policy APIs and stores the unexpanded template", () => {
  const agents = fs.readFileSync(new URL("web/agents.js", import.meta.url), "utf8");
  assert.match(agents, /policyReferences: true/);
  assert.match(source, /api\("GET", `\/api\/policies\/policies\/\$\{enc\(id\)\}\/latest`\)/);
  assert.match(source, /storedFiles\[promptFile\.name\]/);
  assert.doesNotMatch(source, /api\/blobs.*policy/);
  assert.ok(source.indexOf("prepareFiles(areas, problem)") < source.indexOf("confirmAction(\"Save these changes as a new version?"), "validation precedes version confirmation");
  const create = source.slice(source.indexOf("async function create"), source.indexOf("// ---- Content"));
  assert.ok(create.indexOf("await prepareFiles") < create.indexOf("confirmAction"), "validation precedes confirmation");
  assert.ok(create.indexOf("confirmAction") < create.indexOf('api("POST"'), "only confirmed content is written");
});

test("the save lock covers asynchronous validation and prevents duplicate writes", async () => {
  const { runExclusive } = setup();
  const state = { busy: false };
  const control = { disabled: false, isConnected: true };
  let release;
  let writes = 0;
  const validating = new Promise((resolve) => { release = resolve; });
  const first = runExclusive(state, control, async () => { await validating; writes++; });
  const duplicate = await runExclusive(state, control, async () => { writes++; });
  assert.equal(duplicate, false);
  assert.equal(control.disabled, true);
  assert.equal(writes, 0);
  release();
  await first;
  assert.equal(writes, 1);
  assert.equal(control.disabled, false);
});
