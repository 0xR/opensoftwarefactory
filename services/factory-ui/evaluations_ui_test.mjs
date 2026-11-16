import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("web/evaluations.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("web/app.js", import.meta.url), "utf8");
const fillSource = app.slice(app.indexOf("function fill("), app.indexOf("// createTree"));

function setup() {
  const nodes = [], requests = [], elements = new Map();
  const h = (tag, props = {}, ...children) => {
    const node = {
      tag, props, children: children.flat().filter((item) => item !== null && item !== undefined && item !== false),
      value: props.value || "", checked: !!props.checked, disabled: !!props.disabled, textContent: "", className: props.className || "",
      append(...items) { this.children.push(...items.flat().filter(Boolean)); }, replaceChildren(...items) { this.children = items.map((item) => (item === null || item === undefined ? String(item) : item)); }, // native: null becomes the text "null"
      addEventListener(name, fn) { this[`on${name}`] = fn; }, focus() {}, classList: { add() {}, toggle() {} },
    };
    if (props.id) { node.id = props.id; elements.set(props.id, node); }
    nodes.push(node); return node;
  };
  for (const id of ["evaluation-sets", "evaluation-runs", "evaluation-detail", "evaluation-filters", "evaluation-actions", "evaluation-detail-title", "evaluation-new-slot"]) elements.set(id, h("div", { id }));
  const context = {
    h, tabs: {}, $: (id) => elements.get(id), URLSearchParams,
    iconButton: (name, label, onclick) => h("button", { title: label, onclick }, name),
    emptyPanel: (text) => h("empty", {}, text), errorPanel: (text) => h("error", {}, text),
    dataTable: (headings, rows) => h("table", { headings }, ...rows), statusChip: (state, word) => h("chip", { state }, word),
    timeEl: (value) => h("time", {}, value), titleCase: (value) => value, midTruncate: (value) => value,
    runState: (value) => String(value).toLowerCase() === "completed" ? "done" : String(value).toLowerCase() === "running" ? "running" : "failed",
    runStateWord: (value) => value, formatTime: () => "now", creatorHeaders: () => ({ "X-Creator": "ada" }),
    setSaveState() {}, setStatus() {}, location: { hash: "" },
    openDialog(config) { context.dialog = config; return { close() {} }; },
    api(method, path, body, headers) {
      requests.push({ method, path, body, headers });
      if (path.startsWith("/api/evaluations/runs")) return Promise.resolve({ runs: [
        { trace_id: "ok", workflow: "feature", agents: ["build@v1"], started: "2026-01-01T00:00:00Z", status: "Completed", duration_ms: 1500 },
        { trace_id: "bad", workflow: "feature", agents: ["build@v1"], started: "2026-01-02T00:00:00Z", status: "Failed", duration_ms: 800 },
      ], next_cursor: "next", incomplete_runs: 1, history_unavailable_omitted: 0 });
      if (path === "/api/agents/agents") return Promise.resolve({ entries: [{ name: "build", versions: [{ version: "v2" }, { version: "v1" }] }] });
      if (path === "/api/orchestrator/workflows") return Promise.resolve({ workflows: [{ name: "feature" }, { name: "small-fix" }] });
      if (method === "GET" && path === "/api/evaluations/sets") return Promise.resolve({ sets: [{ id: "baseline", name: "Baseline", run_count: 1 }] });
    if (method === "GET" && path.endsWith("/baseline")) return Promise.resolve({ id: "baseline", name: "Baseline", revision: 2, updated: "2026-01-01", runs: [] });
      if (method === "POST") return Promise.resolve({ id: "new-set", name: body.name, runs: [] });
      if (method === "GET" && path.endsWith("/new-set")) return Promise.resolve({ id: "new-set", name: "New set", updated: "2026-01-01", runs: [] });
      return Promise.resolve({ id: "baseline", name: "Baseline", updated: "2026-01-01", runs: [] });
    },
  };
  vm.runInNewContext(`${fillSource}\n${source}`, context);
  return { context, nodes, requests, elements };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

test("evaluation run filters, failure marking and explicit page selection feed a new set", async () => {
  const { context, nodes, requests, elements } = setup();
  context.tabs.evaluations.show(""); await settle();
  const table = nodes.find((node) => node.tag === "table");
  assert.ok(table.children.some((row) => row.className === "run-failed"), "failed run is visibly marked");
  assert.ok(nodes.some((node) => node.props.className === "evidence-warning evaluation-index-warning"));
  elements.get("evaluation-agent").value = "build@v1";
  elements.get("evaluation-duration-min").value = "1.5";
  elements.get("evaluation-filters").onsubmit({ preventDefault() {} }); await settle();
  assert.match(requests.filter((request) => request.path.startsWith("/api/evaluations/runs"))[1].path, /agent=build%40v1/);
  assert.match(requests.filter((request) => request.path.startsWith("/api/evaluations/runs"))[1].path, /duration_min_ms=1500/);
  assert.equal(elements.get("evaluation-agent").tag, "select");
  assert.equal(elements.get("evaluation-workflow").tag, "select");
  assert.equal(elements.get("evaluation-status").tag, "select");
  const agentValues = elements.get("evaluation-agent").children.map((option) => option.value);
  assert.deepEqual(Array.from(agentValues), ["", "build@v1", "build@v2"]);
  assert.deepEqual(Array.from(elements.get("evaluation-workflow").children, (option) => option.value), ["", "feature", "small-fix"]);
  const selectPage = nodes.find((node) => node.tag === "button" && node.children.includes("Select page"));
  selectPage.props.onclick();
  const createSet = nodes.filter((node) => node.tag === "button" && String(node.children[0]).startsWith("Create set")).at(-1);
  assert.match(createSet.children[0], /\(2\)/, "selection persists and states its exact scope");
  createSet.props.onclick();
  const name = nodes.find((node) => node.id === "evaluation-set-name"); name.value = "Regression baseline";
  const create = context.dialog.footer.find((node) => node.children.includes("Create set"));
  await create.onclick(); await settle();
  const posted = requests.find((request) => request.method === "POST");
  assert.equal(posted.body.name, "Regression baseline");
  assert.deepEqual(Array.from(posted.body.run_ids).sort(), ["bad", "ok"]);
});

test("saved sets preserve missing source snapshots and support removal", async () => {
  const { context, requests, nodes } = setup();
  context.api = (method, path, body) => {
    requests.push({ method, path, body });
    if (method === "GET" && path === "/api/evaluations/sets") return Promise.resolve({ sets: [{ id: "baseline", name: "Baseline", run_count: 1, missing_run_count: 1 }] });
    if (method === "GET" && path.endsWith("/baseline")) return Promise.resolve({ id: "baseline", name: "Baseline", revision: 2, updated: "2026-01-01", runs: [{ trace_id: "gone", workflow: "feature", source_present: false }] });
    return Promise.resolve({ id: "baseline", name: "Baseline", updated: "2026-01-01", runs: [] });
  };
  context.tabs.evaluations.show("/baseline"); await settle();
  const warning = nodes.find((node) => node.props.className === "evidence-warning");
  assert.match(warning.children.join(""), /saved snapshots remain/i);
  const remove = nodes.find((node) => node.tag === "button" && node.children.includes("Remove"));
  await remove.props.onclick(); await settle();
  const update = requests.find((request) => request.method === "PUT");
  assert.deepEqual(Array.from(update.body.run_ids), []);
  assert.equal(update.body.expected_revision, 2);
});

test("an older filtered response cannot replace newer results", async () => {
  const { context, nodes, elements } = setup();
  context.tabs.evaluations.show(""); await settle();
  let resolveOld, resolveNew, call = 0;
  const original = context.api;
  context.api = (method, path, body, headers) => {
    if (!path.startsWith("/api/evaluations/runs")) return original(method, path, body, headers);
    call++;
    return new Promise((resolve) => { if (call === 1) resolveOld = resolve; else resolveNew = resolve; });
  };
  elements.get("evaluation-workflow").value = "old";
  elements.get("evaluation-filters").onsubmit({ preventDefault() {} });
  elements.get("evaluation-workflow").value = "new";
  elements.get("evaluation-filters").onsubmit({ preventDefault() {} });
  resolveNew({ runs: [{ trace_id: "new", workflow: "new", status: "Unknown", started: "2026-01-01" }] }); await settle();
  resolveOld({ runs: [{ trace_id: "old", workflow: "old", status: "Failed", started: "2026-01-01" }] }); await settle();
  const table = nodes.filter((node) => node.tag === "table").at(-1);
  assert.match(JSON.stringify(table), /new/);
  assert.doesNotMatch(JSON.stringify(table), /old/);
  assert.equal(table.children[0].children[1].children[0].props.state, "idle", "unknown history remains unknown rather than failed");
});

test("missing Temporal history is a neutral row state, not a global index warning", async () => {
  const { context, nodes } = setup();
  const original = context.api;
  context.api = (method, path, body, headers) => path.startsWith("/api/evaluations/runs")
    ? Promise.resolve({ runs: [{ trace_id: "legacy", workflow: "feature", agents: ["build@v1"], agents_complete: true, started: "2026-01-01", status: "Unknown", history_unavailable: true, duration_known: false }], incomplete_runs: 0, history_unavailable: 1, history_unavailable_omitted: 0 })
    : original(method, path, body, headers);
  context.tabs.evaluations.show(""); await settle();
  assert.equal(nodes.some((node) => node.props.className === "evidence-warning evaluation-index-warning"), false);
  const table = nodes.filter((node) => node.tag === "table").at(-1);
  assert.equal(table.children[0].children[1].children[0].children[0], "History unavailable");
  assert.equal(table.children[0].children[1].children[0].props.state, "idle");
});
