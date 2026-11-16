import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The Workflows page runs here against a small stand-in for the DOM and for the helpers of
// app.js, with the orchestrator answering as docs/plans/workflow-versions.md says. It covers
// what the logic tests cannot: that the page code loads, saves versions, switches between
// them, and asks before unsaved edits are lost.

const read = (name) => fs.readFileSync(new URL(`web/${name}`, import.meta.url), "utf8");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setTimeout(done, 0)); };
const plain = (value) => JSON.parse(JSON.stringify(value));

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.dataset = {};
    this.hidden = false; this.value = ""; this.text = "";
    const names = new Set();
    this.classList = {
      add: (...n) => n.forEach((x) => names.add(x)), remove: (...n) => n.forEach((x) => names.delete(x)),
      toggle: (n, on = !names.has(n)) => { if (on) names.add(n); else names.delete(n); return on; }, contains: (n) => names.has(n),
    };
  }
  adopt(items) { return items.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== "").map((c) => { if (c instanceof FakeNode) c.parentNode = this; return c; }); }
  append(...items) { this.children.push(...this.adopt(items)); }
  prepend(...items) { this.children.unshift(...this.adopt(items)); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...items) { this.children = this.adopt(items); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {} select() {} setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
  get parentElement() { return this.parentNode || (this.auto ||= new FakeNode("div")); }
  get clientWidth() { return 800; }
  get offsetWidth() { return 100; }
  get options() { return this.children; }
  get isConnected() { return true; }
  get textContent() { return this.text || this.children.map((c) => (c instanceof FakeNode ? c.textContent : String(c))).join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  set innerHTML(value) { this.html = value; }
}

const all = (node) => (node instanceof FakeNode ? [node, ...node.children.flatMap(all)] : []);
const find = (root, test) => all(root).find(test);
const fire = async (node, type, ev = {}) => {
  const event = { target: node, button: 0, key: "", preventDefault() {}, stopPropagation() {}, ...ev };
  if (typeof node[`on${type}`] === "function") node[`on${type}`](event);
  for (const fn of node.listeners[type] || []) fn(event);
  await settle();
};

// The orchestrator as the contract describes it, holding every version of every workflow.
function orchestrator() {
  const step = (id, extra = {}) => ({ id, service: "agent", agent: "demo/coder@v1", ...extra });
  const store = {
    demo: [1, 2, 3].map((version) => ({ name: "demo", version, created: `2026-11-0${version}T10:00:00Z`, created_by: "ada",
      steps: [step("plan", { position: { x: 0, y: 40 } }), ...(version > 1 ? [{ id: "build", service: "workflow", workflow: "inner@v1", depends_on: ["plan"], position: { x: 0, y: 176 } }] : [])] })),
    inner: [1, 2].map((version) => ({ name: "inner", version, created: "2026-11-01T10:00:00Z", created_by: "ada", steps: [step(version === 1 ? "old-write" : "write")] })),
  };
  const calls = [];
  // crew is added by the team test, so the other tests keep their two workflows.
  const crew = { name: "crew", version: 1, steps: [{ id: "team", service: "team", agent: "demo/coder@v1", workflows: ["inner@v1"], channels: [["coder", "inner"]], position: { x: 0, y: 40 } }] };
  const withList = (name, def) => ({ ...structuredClone(def), versions: store[name].map((d) => d.version) });
  const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
  async function api(method, path, body, headers = {}) {
    calls.push({ method, path, body: body === undefined ? undefined : plain(body), headers });
    if (path === "/api/agents/agents") return { entries: [{ name: "demo/coder", versions: ["v1"] }] };
    if (path.startsWith("/api/agents/agents/")) return { files: { "systemprompt.md": "Write code.", "agent.json": { models: ["local"] } } };
    const rest = path.replace("/api/orchestrator/workflows", "");
    const [, name, kind, n] = rest.split("/").map(decodeURIComponent);
    if (method === "GET" && !rest) return { workflows: Object.keys(store).map((key) => withList(key, store[key].at(-1))) };
    if (method === "GET" && kind === "versions") {
      const def = store[name]?.find((d) => d.version === Number(n));
      if (!def) throw fail(404, "not found");
      return withList(name, def);
    }
    if (method === "POST" && kind === "versions") {
      if (!body.steps?.length) throw fail(422, `workflow "${name}" has no steps`);
      const list = (store[name] ||= []);
      list.push({ ...structuredClone(body), name, version: list.length + 1, created: "2026-11-15T10:00:00Z", created_by: headers["X-Creator"] || "" });
      return withList(name, list.at(-1));
    }
    if (method === "POST" && kind === "rename") {
      if (store[body.name]) throw fail(409, `workflow "${body.name}" exists`);
      store[body.name] = store[name].map((d) => ({ ...d, name: body.name }));
      delete store[name];
      return {};
    }
    if (method === "DELETE" && name && !kind) { delete store[name]; return {}; }
    throw fail(404, `${method} ${path}`);
  }
  return { api, calls, store, crew };
}

function page() {
  const server = orchestrator();
  const ids = new Map(), selectors = new Map();
  const byId = (id) => { if (!ids.has(id)) ids.set(id, new FakeNode("div")); return ids.get(id); };
  const notices = [], questions = [], menus = [], inputs = [];
  const storage = new Map();
  const answers = { confirm: true };
  const h = (tag, props = {}, ...children) => {
    const node = new FakeNode(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.includes("-")) node.setAttribute(key, value);
      else node[key] = value;
    }
    node.append(...children);
    return node;
  };
  const context = {
    console, setTimeout, clearTimeout, structuredClone, h, $: byId,
    document: {
      querySelector: (selector) => { if (!selectors.has(selector)) selectors.set(selector, new FakeNode("div")); return selectors.get(selector); },
      createElementNS: (_ns, name) => new FakeNode(name), addEventListener() {}, activeElement: null,
    },
    window: { addEventListener() {} },
    location: { hash: "#workflows" },
    history: { pushState(_s, _t, url) { context.location.hash = url; }, replaceState(_s, _t, url) { context.location.hash = url; } },
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => fn(),
    ICONS: new Proxy({}, { get: () => "" }),
    tabs: {}, pageToggles: {}, activeTab: "workflows",
    menu: { hidden: true }, closeMenu() {}, openMenu: (_ev, items) => menus.push(items),
    openPopover: () => ({ close() {} }), fitWidth() {},
    titleCase: (id) => String(id || "").split(/[-_\s]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" "),
    iconButton: (name, label, onclick) => h("button", { title: label, onclick }),
    emptyPanel: (title, action) => h("div", { className: "empty", title, action }),
    errorPanel: (message) => h("div", { className: "error-panel", title: message }),
    textView: () => ({ toggle: h("button"), body: h("div") }),
    api: server.api,
    creatorHeaders: () => ({ "X-Creator": "ada" }),
    setStatus: (text, kind = "", action) => { notices.push({ text, kind }); if (action) context.undo = action.run; },
    setSaveState: (text = "Saved") => notices.push({ text, kind: "" }),
    dropUndo: () => { context.undo = null; },
    confirmAction: async (question, action) => { questions.push(`${question} [${action}]`); return answers.confirm; },
    Inputs: { setBlocker(fn) { context.blocker = fn; }, open: (...args) => inputs.push(args) },
  };
  vm.runInNewContext(`${read("workflowref.js")}\n${read("workflows.js")}`, context);
  const head = selectors.get("#tab-workflows .canvas-head");
  const ui = {
    context, server, notices, questions, inputs, answers, byId,
    save: () => find(head, (n) => n.className === "primary wf-save"),
    versions: () => find(head, (n) => n.tag === "select"),
    note: () => find(head, (n) => n.className === "wf-version-note"),
    shownVersion: () => ui.versions().children.find((o) => o.selected)?.textContent,
    rows: () => byId("wf-list").children,
    names: () => ui.rows().map((li) => li.textContent),
    selectedRow: () => ui.rows().find((li) => li.attrs["aria-selected"] === "true")?.textContent,
    tiles: () => all(byId("canvas")).filter((n) => n.attrs["data-step"]).map((n) => n.attrs["data-step"]),
    // menu opens the canvas menu and returns the item with that label: [label, run, class, tip, disabled].
    async menu(label, node = byId("canvas")) {
      menus.length = 0;
      await fire(node, "contextmenu");
      const item = menus.at(-1).find((entry) => Array.isArray(entry) && entry[0] === label);
      assert.ok(item, `menu item ${label}`);
      return item;
    },
    async run(label, node) { const item = await ui.menu(label, node); assert.ok(!item[4], `${label} is enabled`); await item[1](); await settle(); },
    posts: () => server.calls.filter((c) => c.method !== "GET"),
    async open(rest = "") { context.tabs.workflows.show(rest); await settle(); },
  };
  return ui;
}

test("the page opens the newest version, lists the versions, and saves nothing by itself", async () => {
  const ui = page();
  await ui.open();
  assert.deepEqual(ui.names(), ["Demo", "Inner"]);
  assert.equal(ui.selectedRow(), "Demo");
  assert.deepEqual(ui.versions().children.map((o) => o.textContent), ["v3 (newest)", "v2", "v1"]);
  assert.equal(ui.shownVersion(), "v3 (newest)");
  assert.deepEqual(ui.tiles(), ["plan", "build"]);
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.save().title, "No unsaved edits");
  assert.equal(ui.note().hidden, true);
  assert.equal(ui.context.location.hash, "#workflows/demo/plan", "the newest version needs no version in the hash");
  assert.deepEqual(ui.posts(), [], "loading writes nothing");
  // A workflow tile names the workflow and the version it is pinned to.
  const build = find(ui.byId("canvas"), (n) => n.attrs["data-step"] === "build");
  assert.equal(build.attrs["aria-label"], "Step build: Inner v1");
});

test("an edit stays unsaved until Save, which stores the next version and shows it", async () => {
  const ui = page();
  await ui.open();
  await ui.run("Add step");
  assert.deepEqual(ui.tiles(), ["plan", "build", "step-1"]);
  assert.equal(ui.save().disabled, false);
  assert.equal(ui.save().title, "Stores the workflow as v4");
  await settle();
  assert.deepEqual(ui.posts(), [], "no autosave");
  // Selecting another node keeps the unsaved edit.
  await fire(find(ui.byId("canvas"), (n) => n.attrs["data-step"] === "plan"), "keydown", { key: "Enter" });
  assert.deepEqual(ui.tiles(), ["plan", "build", "step-1"]);
  assert.equal(ui.save().disabled, false);
  // With unsaved edits a run is refused: it would use the stored version, not what is shown.
  assert.equal((await ui.menu("Run workflow…"))[4], true);
  assert.match(ui.context.blocker(), /saved first/);
  await ui.save().onclick();
  await settle();
  const [post] = ui.posts();
  assert.equal(post.method, "POST");
  assert.equal(post.path, "/api/orchestrator/workflows/demo/versions");
  assert.deepEqual(post.headers, { "X-Creator": "ada" });
  assert.deepEqual(Object.keys(post.body).sort(), ["name", "steps"], "without the fields the orchestrator sets");
  assert.deepEqual(post.body.steps.map((s) => s.id), ["plan", "build", "step-1"]);
  assert.equal(post.body.steps[1].workflow, "inner@v1", "the pin is stored as it is");
  assert.ok(post.body.steps[2].position, "positions are saved with the version");
  assert.deepEqual(ui.versions().children.map((o) => o.textContent), ["v4 (newest)", "v3", "v2", "v1"]);
  assert.equal(ui.shownVersion(), "v4 (newest)");
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.notices.at(-1).text, "Saved v4");
  assert.equal(ui.context.blocker(), "");
  // The run now uses the version on the canvas.
  await ui.run("Run workflow…");
  assert.deepEqual(ui.inputs.at(-1), ["demo", 4]);
});

test("a refused save keeps the edits and names the reason", async () => {
  const ui = page();
  await ui.open();
  await ui.run("Add step");
  const real = ui.context.api;
  ui.context.api = async (method, path, ...rest) => {
    if (method === "POST") { const e = new Error('step "step-1" names an agent that does not exist'); e.status = 422; throw e; }
    return real(method, path, ...rest);
  };
  await ui.save().onclick();
  await settle();
  assert.deepEqual(ui.notices.at(-1), { text: "Not saved: step Step 1 names an agent that does not exist", kind: "error" });
  assert.deepEqual(ui.tiles(), ["plan", "build", "step-1"]);
  assert.equal(ui.save().disabled, false);
  assert.equal(ui.shownVersion(), "v3 (newest)");
});

test("an older version is read-only until edited and is then saved as the next version", async () => {
  const ui = page();
  await ui.open();
  ui.versions().value = "2";
  await fire(ui.versions(), "change");
  assert.ok(ui.server.calls.some((c) => c.method === "GET" && c.path === "/api/orchestrator/workflows/demo/versions/2"));
  assert.equal(ui.shownVersion(), "v2");
  assert.equal(ui.note().hidden, false);
  assert.equal(ui.note().textContent, "Read-only: v2");
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.context.location.hash, "#workflows/demo/plan?version=2", "a reload returns to this version");
  // A run from here uses v2.
  await ui.run("Run workflow…");
  assert.deepEqual(ui.inputs.at(-1), ["demo", 2]);
  await ui.run("Add step");
  assert.equal(ui.note().textContent, "Edited v2: saves as v4");
  assert.equal(ui.save().title, "Stores the workflow as v4");
  await ui.save().onclick();
  await settle();
  assert.equal(ui.posts()[0].path, "/api/orchestrator/workflows/demo/versions");
  assert.equal(ui.shownVersion(), "v4 (newest)");
  assert.equal(ui.note().hidden, true);
  assert.equal(ui.context.location.hash, "#workflows/demo/step-1", "the saved version is the newest: no version in the hash");
  assert.equal(ui.server.store.demo[1].steps.length, 2, "v2 itself never changes");
});

test("a reload returns to the version in the hash; one that is gone gives way to the newest", async () => {
  const ui = page();
  await ui.open("/demo/plan?version=1");
  assert.equal(ui.shownVersion(), "v1");
  assert.deepEqual(ui.tiles(), ["plan"]);
  assert.equal(ui.note().textContent, "Read-only: v1");
  const other = page();
  await other.open("/demo?version=9");
  assert.equal(other.shownVersion(), "v3 (newest)");
  assert.equal(other.context.location.hash, "#workflows/demo/plan");
});

test("another workflow or version is opened over unsaved edits only after asking", async () => {
  const ui = page();
  await ui.open();
  await ui.run("Add step");
  ui.answers.confirm = false;
  await fire(ui.rows()[1], "click");
  assert.deepEqual(ui.questions, ["Discard your unsaved changes? [Discard]"]);
  assert.equal(ui.selectedRow(), "Demo");
  assert.deepEqual(ui.tiles(), ["plan", "build", "step-1"], "the edits stay");
  // The version select and a link (the hash) ask as well; kept edits put the hash back.
  ui.versions().value = "1";
  await fire(ui.versions(), "change");
  assert.equal(ui.shownVersion(), "v3 (newest)");
  assert.equal(ui.questions.length, 2);
  ui.context.location.hash = "#workflows/inner";
  await ui.open("/inner");
  assert.equal(ui.questions.length, 3);
  assert.equal(ui.selectedRow(), "Demo");
  assert.equal(ui.context.location.hash, "#workflows/demo/step-1");
  // Leaving the page and coming back keeps the edits without loading over them.
  const gets = ui.server.calls.filter((c) => c.path === "/api/orchestrator/workflows").length;
  ui.context.tabs.workflows.hide();
  await ui.open("");
  assert.deepEqual(ui.tiles(), ["plan", "build", "step-1"]);
  assert.equal(ui.server.calls.filter((c) => c.path === "/api/orchestrator/workflows").length, gets);
  assert.equal(ui.questions.length, 3, "the same workflow asks nothing");
  // Discarding opens the other workflow and drops the edits.
  ui.answers.confirm = true;
  await fire(ui.rows()[1], "click");
  assert.equal(ui.selectedRow(), "Inner");
  assert.deepEqual(ui.tiles(), ["write"]);
  assert.equal(ui.save().disabled, true);
  await fire(ui.rows()[0], "click");
  assert.equal(ui.questions.length, 4, "nothing to ask without edits");
  assert.deepEqual(ui.tiles(), ["plan", "build"]);
  assert.deepEqual(ui.posts(), []);
});

test("undo puts a deleted step back and leaves it unsaved like any edit", async () => {
  const ui = page();
  await ui.open();
  const tile = find(ui.byId("canvas"), (n) => n.attrs["data-step"] === "plan");
  await ui.run("Delete step", tile);
  assert.deepEqual(ui.tiles(), ["build"]);
  assert.equal(ui.save().disabled, false);
  assert.equal(ui.notices.at(-1).text, "Deleted");
  ui.context.undo();
  await settle();
  assert.deepEqual(ui.tiles().sort(), ["build", "plan"]);
  assert.equal(ui.save().disabled, true, "back to the stored version: nothing to save");
  assert.deepEqual(ui.posts(), []);
});

test("a workflow node opens the version it is pinned to, and the path leads back", async () => {
  const ui = page();
  await ui.open();
  await fire(ui.byId("canvas"), "dblclick", { target: { closest: () => ({ getAttribute: () => "build" }) } });
  assert.ok(ui.server.calls.some((c) => c.path === "/api/orchestrator/workflows/inner/versions/1"), "the pinned v1 is loaded");
  assert.equal(ui.selectedRow(), "Inner");
  assert.deepEqual(ui.tiles(), ["old-write"], "v1 of inner, not its newest");
  assert.equal(ui.shownVersion(), "v1");
  assert.equal(ui.context.location.hash, "#workflows/inner/old-write?version=1&path=demo");
  const path = find(ui.context.document.querySelector("#tab-workflows .canvas-head"), (n) => n.className === "wf-path");
  assert.equal(path.hidden, false);
  assert.equal(path.children[0].textContent, "Demo");
  assert.equal(path.children[0].href, "#workflows/demo");
});

test("a new workflow is a draft until its first Save stores v1", async () => {
  const ui = page();
  await ui.open();
  await ui.run("New workflow");
  assert.deepEqual(ui.names().length, 3);
  assert.equal(ui.versions().hidden, true, "nothing stored yet");
  assert.equal(ui.note().textContent, "Not saved yet");
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.save().title, "Needs a step");
  assert.deepEqual(ui.posts(), [], "a draft is not stored");
  // The name is typed in the list row; a draft is renamed on the page only.
  const input = find(ui.byId("wf-list"), (n) => n.className === "rename");
  input.value = "Release Notes";
  await fire(input, "keydown", { key: "Enter" });
  assert.equal(ui.selectedRow(), "Release Notes");
  assert.deepEqual(ui.posts(), []);
  await ui.run("Add step");
  assert.equal(ui.save().disabled, false);
  assert.equal(ui.save().title, "Stores the workflow as v1");
  assert.equal((await ui.menu("Run workflow…"))[4], true, "a draft cannot run");
  await ui.save().onclick();
  await settle();
  assert.equal(ui.posts()[0].path, "/api/orchestrator/workflows/release-notes/versions");
  assert.equal(ui.posts()[0].body.name, "release-notes");
  assert.equal(ui.versions().hidden, false);
  assert.equal(ui.shownVersion(), "v1 (newest)");
  assert.equal(ui.notices.at(-1).text, "Saved v1");
  // A draft that is left without a step is gone.
  await ui.run("New workflow");
  assert.equal(ui.names().length, 4);
  await fire(ui.rows()[0], "click");
  assert.equal(ui.names().length, 3);
  assert.equal(ui.questions.length, 0, "an empty draft holds no work");
});

test("rename, duplicate and delete go to the orchestrator", async () => {
  const ui = page();
  await ui.open();
  // Duplicate stores the copy at once as v1 of a new name and opens it.
  await ui.run("Duplicate workflow");
  assert.equal(ui.posts()[0].path, "/api/orchestrator/workflows/demo-copy/versions");
  assert.equal(ui.posts()[0].body.name, "demo-copy");
  assert.equal(ui.posts()[0].body.steps.length, 2);
  assert.equal(ui.selectedRow(), "Demo Copy");
  assert.equal(ui.shownVersion(), "v1 (newest)");
  assert.equal(ui.notices.some((n) => n.text === "Duplicated"), true);
  // Rename asks the orchestrator, which follows the name in every workflow; the page follows too.
  await fire(ui.rows()[1], "click");
  await ui.run("Rename workflow");
  const input = find(ui.byId("wf-list"), (n) => n.className === "rename");
  input.value = "Core";
  await fire(input, "keydown", { key: "Enter" });
  const rename = ui.posts().at(-1);
  assert.equal(rename.path, "/api/orchestrator/workflows/inner/rename");
  assert.deepEqual(rename.body, { name: "core" });
  assert.equal(ui.selectedRow(), "Core");
  assert.equal(ui.notices.at(-1).text, "Renamed");
  await fire(ui.rows()[0], "click");
  const build = find(ui.byId("canvas"), (n) => n.attrs["data-step"] === "build");
  assert.equal(build.attrs["aria-label"], "Step build: Core v1", "the node follows the new name and keeps its version");
  assert.equal(ui.save().disabled, true, "following a rename is no unsaved edit");
  // Delete asks first, then removes every version.
  ui.answers.confirm = false;
  await ui.run("Delete workflow");
  assert.equal(ui.questions.at(-1), "Delete Demo with all its versions? [Delete]");
  assert.equal(ui.posts().some((c) => c.method === "DELETE"), false);
  ui.answers.confirm = true;
  await ui.run("Delete workflow");
  assert.equal(ui.posts().at(-1).method, "DELETE");
  assert.equal(ui.posts().at(-1).path, "/api/orchestrator/workflows/demo");
  assert.deepEqual(ui.names(), ["Core", "Demo Copy"]);
  assert.equal(ui.notices.at(-1).text, "Deleted");
  assert.equal(ui.posts().some((c) => c.method === "PUT"), false);
});

test("the node panel of a workflow step has a Workflow and a Version select", async () => {
  const ui = page();
  await ui.open("/demo/build");
  const field = (name) => find(ui.byId("inspector"), (n) => n.dataset.field === name);
  assert.deepEqual(field("workflow").children.map((o) => [o.value, o.selected]), [["inner", true]]);
  assert.deepEqual(field("workflow_version").children.map((o) => [o.textContent, o.selected]), [["v2 (newest)", false], ["v1", true]]);
  // The steps card shows the pinned version, loaded on demand.
  assert.ok(ui.server.calls.some((c) => c.path === "/api/orchestrator/workflows/inner/versions/1"));
  assert.equal(find(ui.byId("inspector"), (n) => n.className === "nested-step-name").textContent, "Old Write");
  // Choosing the newest version changes the stored reference and is an unsaved edit.
  const form = find(ui.byId("inspector"), (n) => n.className === "step-form");
  const version = field("workflow_version");
  version.value = "2";
  await fire(form, "change", { target: version });
  assert.equal(ui.save().disabled, false);
  await ui.save().onclick();
  await settle();
  assert.equal(ui.posts()[0].body.steps[1].workflow, "inner@v2");
});

test("a team's workflow member is pinned, named by its workflow, and can move to the newest version", async () => {
  const ui = page();
  ui.server.store.crew = [ui.server.crew];
  await ui.open("/crew/team");
  const member = () => find(ui.byId("inspector"), (n) => n.dataset.member === "inner");
  assert.equal(member().textContent, "innerWorkflow v1", "the name without the version, then the pinned version");
  assert.equal(find(ui.byId("canvas"), (n) => n.attrs["data-step"] === "team").attrs["aria-label"], "Step team: demo/coder@v1 · 2 members");
  // "+" offers the workflows that are not members yet, pinned to their newest version.
  const menus = [];
  ui.context.openMenu = (_ev, items) => menus.push(items);
  await fire(find(ui.byId("inspector"), (n) => n.title === "Add member"), "click");
  assert.deepEqual(plain(menus.at(-1).filter(Array.isArray).map((item) => item[0])), ["Demo v3 (workflow)"], "inner is a member already, at whatever version");
  // The member's menu opens the pinned version or moves the pin to the newest.
  await fire(member(), "contextmenu");
  const labels = plain(menus.at(-1).filter(Array.isArray).map((item) => item[0]));
  assert.deepEqual(labels, ["Open workflow", "Use v2", "Make lead", "Reset layout", "Remove member"]);
  await menus.at(-1).find((item) => item[0] === "Use v2")[1]();
  await settle();
  assert.equal(member().textContent, "innerWorkflow v2");
  assert.equal(ui.save().disabled, false);
  await ui.save().onclick();
  await settle();
  const stored = ui.posts()[0].body.steps[0];
  assert.deepEqual(stored.workflows, ["inner@v2"]);
  assert.deepEqual(stored.channels, [["coder", "inner"]], "the channel names the member and stays");
  // Adding the offered workflow stores its pinned reference.
  await fire(find(ui.byId("inspector"), (n) => n.title === "Add member"), "click");
  await menus.at(-1).find((item) => item[0] === "Demo v3 (workflow)")[1]();
  await settle();
  await ui.save().onclick();
  await settle();
  assert.deepEqual(ui.posts()[1].body.steps[0].workflows, ["inner@v2", "demo@v3"]);
  // Open workflow shows the pinned version.
  await fire(member(), "contextmenu");
  await menus.at(-1).find((item) => item[0] === "Open workflow")[1]();
  await settle();
  assert.equal(ui.selectedRow(), "Inner");
  assert.equal(ui.shownVersion(), "v2 (newest)");
  assert.equal(ui.context.location.hash, "#workflows/inner/write?path=crew");
});

// ---- Merge and batch nodes (docs/plans/merge-batch.md) ----

// fan adds a workflow with a merge, a batch, and a route step after the merge.
function fan(ui) {
  const agent = (id, extra = {}) => ({ id, service: "agent", agent: "demo/coder@v1", ...extra });
  ui.server.store.fan = [{ name: "fan", version: 1, created: "2026-11-01T10:00:00Z", created_by: "ada", steps: [
    agent("a", { position: { x: 0, y: 40 } }), agent("b", { position: { x: 268, y: 40 } }),
    { id: "collect", service: "merge", depends_on: ["a", "b"], capacity: 4, position: { x: 0, y: 176 } },
    { id: "gather", service: "batch", depends_on: ["b"], size: 2, input_timeout: 30, position: { x: 268, y: 176 } },
    { id: "next", service: "route", depends_on: ["collect"], position: { x: 0, y: 312 } },
  ] }];
}
const panelField = (ui, name) => find(ui.byId("inspector"), (n) => n.dataset.field === name);
const panelProblems = (ui) => all(ui.byId("inspector")).filter((n) => n.className === "error-text team-problem").map((n) => n.textContent);
const panelLabels = (ui) => all(ui.byId("inspector")).filter((n) => n.tag === "label").map((n) => n.textContent);
const change = async (ui, name, value) => {
  const control = panelField(ui, name);
  control.value = value;
  await fire(find(ui.byId("inspector"), (n) => n.className === "step-form"), "change", { target: control });
};

test("a merge and a batch have their own tiles: a funnel and a tray, named by what they do", async () => {
  const ui = page();
  fan(ui);
  await ui.open("/fan/collect");
  const tile = (id) => find(ui.byId("canvas"), (n) => n.attrs["data-step"] === id);
  const body = (id) => find(tile(id), (n) => n.attrs.class === "body").attrs.d;
  const lines = (id) => all(tile(id)).filter((n) => n.tag === "text").map((n) => n.textContent);
  assert.equal(body("collect"), "M0,0 H220 V20 L192,64 H28 L0,20 z", "a funnel: wide at the top, narrow at the bottom");
  assert.deepEqual(lines("collect"), ["Collect", "Waits for all"]);
  assert.deepEqual(lines("gather"), ["Gather", "Collects 2"]);
  assert.ok(find(tile("gather"), (n) => n.attrs.class === "tray-line"), "a tray: a second line under the top edge");
  assert.equal(find(tile("collect"), (n) => n.attrs.class === "tray-line"), undefined);
  assert.notEqual(body("gather"), body("a"));
  // Both keep the ports of every tile, in and out.
  for (const id of ["collect", "gather"]) assert.equal(all(tile(id)).filter((n) => n.attrs.class === "port").length, 2, id);
  assert.ok(find(tile("collect"), (n) => n.attrs.class === "bar-merge") && find(tile("gather"), (n) => n.attrs.class === "bar-batch"));
});

test("the node panel of a merge or batch has Node ID, its sources and its parameters, and no agent fields", async () => {
  const ui = page();
  fan(ui);
  await ui.open("/fan/collect");
  assert.equal(find(ui.byId("inspector"), (n) => n.tag === "h2").textContent, "Merge");
  assert.deepEqual(panelLabels(ui), ["Node ID", "Sources", "Service", "Capacity", "Input timeout"]);
  assert.equal(find(ui.byId("inspector"), (n) => n.className === "node-sources").textContent, "A, B", "the sources in their order, read-only");
  assert.equal(panelField(ui, "capacity").value, 4);
  assert.equal(panelField(ui, "capacity").placeholder, "16", "the default");
  assert.equal(panelField(ui, "input_timeout").value, "");
  assert.equal(panelField(ui, "input_timeout").placeholder, "300");
  assert.equal(panelField(ui, "capacity").type, undefined, "a plain digit field, no spinner");
  for (const gone of ["agent", "timeout", "attempts", "question", "activity", "size"]) assert.equal(panelField(ui, gone), undefined, gone);
  assert.deepEqual(panelProblems(ui), []);

  await ui.open("/fan/gather");
  assert.equal(find(ui.byId("inspector"), (n) => n.tag === "h2").textContent, "Batch");
  assert.deepEqual(panelLabels(ui), ["Node ID", "Sources", "Service", "Size", "Input timeout"]);
  assert.equal(find(ui.byId("inspector"), (n) => n.className === "node-sources").textContent, "B");
  assert.equal(panelField(ui, "size").value, 2);
  assert.equal(panelField(ui, "input_timeout").value, 30);
  assert.equal(panelField(ui, "capacity"), undefined);

  // The parameters are stored as numbers and left out when empty; Save sends them.
  await change(ui, "size", "3");
  await change(ui, "input_timeout", "");
  await ui.open("/fan/collect");
  await change(ui, "input_timeout", "120");
  await ui.save().onclick();
  await settle();
  const stored = ui.posts()[0].body.steps;
  assert.deepEqual(stored.find((s) => s.id === "gather"), { id: "gather", service: "batch", depends_on: ["b"], size: 3, position: { x: 268, y: 176 } });
  assert.deepEqual(stored.find((s) => s.id === "collect"), { id: "collect", service: "merge", depends_on: ["a", "b"], capacity: 4, input_timeout: 120, position: { x: 0, y: 176 } });
});

test("problems the orchestrator would refuse show in the node panel, like a team's", async () => {
  const ui = page();
  fan(ui);
  await ui.open("/fan/next");
  assert.deepEqual(panelProblems(ui), ["A router cannot follow a merge: Collect"]);
  await ui.open("/fan/gather");
  await change(ui, "size", "0");
  assert.deepEqual(panelProblems(ui), ["Size must be a whole number of 1 or more"]);
  await change(ui, "size", "");
  await change(ui, "input_timeout", "-1");
  assert.deepEqual(panelProblems(ui), ["A batch needs a size", "Input timeout must be a whole number of 1 or more"]);
  // A new node has no source yet; a batch has no size either.
  await ui.run("Add merge");
  assert.ok(ui.tiles().includes("merge-1"));
  assert.deepEqual(panelProblems(ui), ["A merge needs at least one source"]);
  assert.equal(find(ui.byId("inspector"), (n) => n.className === "node-sources none").textContent, "No sources");
  await ui.run("Add batch");
  assert.ok(ui.tiles().includes("batch-1"));
  assert.deepEqual(panelProblems(ui), ["A batch needs at least one source", "A batch needs a size"]);
  // The orchestrator stays the authority: Save is not blocked by a problem.
  assert.equal(ui.save().disabled, false);
});

test("a step that changes its kind to or from merge and batch drops the fields of the other kind", async () => {
  const ui = page();
  fan(ui);
  await ui.open("/fan/a");
  await change(ui, "timeout", "5m");
  await change(ui, "service", "batch");
  assert.equal(find(ui.byId("inspector"), (n) => n.tag === "h2").textContent, "Batch");
  for (const gone of ["agent", "timeout", "attempts"]) assert.equal(panelField(ui, gone), undefined, gone);
  await ui.open("/fan/gather");
  await change(ui, "service", "merge");
  assert.equal(panelField(ui, "size"), undefined);
  assert.equal(panelField(ui, "input_timeout").value, 30, "the parameter both kinds have stays");
  await ui.open("/fan/collect");
  await change(ui, "service", "agent");
  await ui.save().onclick();
  await settle();
  const stored = ui.posts()[0].body.steps;
  assert.deepEqual(stored.find((s) => s.id === "a"), { id: "a", service: "batch", position: { x: 0, y: 40 } });
  assert.deepEqual(stored.find((s) => s.id === "gather"), { id: "gather", service: "merge", depends_on: ["b"], input_timeout: 30, position: { x: 268, y: 176 } });
  assert.deepEqual(stored.find((s) => s.id === "collect"), { id: "collect", service: "agent", depends_on: ["a", "b"], position: { x: 0, y: 176 } });
});
