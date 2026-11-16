import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("web/mcp-gateway.js", import.meta.url), "utf8")
  .replace(/\}\)\(\);\s*$/, "globalThis.__test = { sseResponse, initializeSession, mcpCall, deleteSession, renderList, renderConfig, renderTest, load, refresh, loadTools, resetConnection, hasEdits, state }; })();");
const element = (tag = "div", props = {}, ...children) => { const node = ({
  tag, props, value: props.value || "", disabled: !!props.disabled, children: children.flat().filter(Boolean), events: {}, textContent: "", focus() {},
  append(...items) { this.children.push(...items); },
  replaceChildren(...items) { this.children = items.flat().filter(Boolean); },
  addEventListener(type, listener) { this.events[type] = listener; },
}); if (props.id) elements.set(props.id, node); return node; };
const elements = new Map();
let lastMenu;
const context = {
  $: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  h: element,
  iconButton: (icon, title, onclick) => element("button", { title, onclick }),
  emptyPanel: (title, action) => element("div", {}, title, action && element("button", { onclick: action.run }, action.label)),
  openMenu: (event, items) => { lastMenu = items; },
  window: { addEventListener() {} },
  history: { replaceState(_s, _t, path) { context.location.hash = path; } },
  location: { hash: "#mcp-gateway" },
  confirmAction: async () => false,
  setSaveState() {}, setStatus() {},
  tabs: {}, TextDecoder, TextEncoder, Uint8Array, AbortController, Response, ReadableStream, setTimeout, clearTimeout,
};
vm.runInNewContext(source, context);

test("SSE parsing returns the matching response and cancels the open stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"jsonrpc":"2.0","method":"notifications/message"}',
        "",
        'data: {"jsonrpc":"2.0","id":7,"result":{"resultType":"complete","content":[]}}',
        "",
      ].join("\n") + "\n"));
    },
    cancel() { cancelled = true; },
  });
  const response = await context.__test.sseResponse(body, 7);
  assert.equal(response.id, 7);
  assert.equal(cancelled, true);
});

test("initialization negotiates 2025-11-25 and propagates the upstream session", async () => {
  const calls = [];
  context.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } },
    }), { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session-7" } });
    if (calls.length === 2) return new Response(null, { status: 202 });
    if (calls.length === 3) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), { headers: { "Content-Type": "application/json" } });
    return new Response(null, { status: 204 });
  };

  const session = await context.__test.initializeSession("context7");
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { service: "context7", id: "session-7" });
  const initialize = JSON.parse(calls[0].init.body);
  assert.deepEqual(initialize.params, {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "factory-ui", version: "1" },
  });
  assert.equal(calls[0].init.headers["MCP-Protocol-Version"], "2025-11-25");
  assert.equal(calls[0].init.headers["Mcp-Method"], undefined);
  assert.equal(calls[0].init.headers["Mcp-Name"], undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(calls[1].init.headers["Mcp-Session-Id"], "session-7");

  await context.__test.mcpCall("context7", "tools/list", {}, session.id);
  assert.equal(calls[2].init.headers["Mcp-Session-Id"], "session-7");
  assert.equal(calls[2].init.headers["Mcp-Param-Tenant"], undefined);

  await context.__test.deleteSession(session);
  assert.equal(calls[3].init.method, "DELETE");
  assert.equal(calls[3].init.headers["Mcp-Session-Id"], "session-7");
});

test("agent tool discovery lists allowed MCP tools and closes its session", async () => {
  const methods = [];
  context.fetch = async (_url, init) => {
    if (init.method === "DELETE") { methods.push("DELETE"); return new Response(null, { status: 204 }); }
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : { tools: [{ name: "search", description: "Search documents" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": "catalog-session" },
    });
  };
  const tools = await context.window.discoverMcpServiceTools("docs");
  assert.deepEqual(JSON.parse(JSON.stringify(tools)), [{ name: "search", description: "Search documents" }]);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "DELETE"]);
});

test("a rejected initialization releases the session returned by the server", async () => {
  const calls = [];
  context.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({
      jsonrpc: "2.0", id: 3,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "old", version: "1" } },
    }), { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "stale-session" } });
    return new Response(null, { status: 204 });
  };
  await assert.rejects(context.__test.initializeSession("old-server"), /unsupported protocol/);
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].init.headers["Mcp-Session-Id"], "stale-session");
});


test("MCP service creation has exactly one Add button in empty and populated sidebars", () => {
  const html = fs.readFileSync(new URL("web/index.html", import.meta.url), "utf8");
  const sidebar = html.split('id="mcp-sidebar"')[1].split('<div class="panel mcp-config">')[0];
  assert.equal((sidebar.match(/id="mcp-new-slot"/g) || []).length, 1);
  assert.equal((sidebar.match(/<button\b/g) || []).length, 0, "no additional static sidebar buttons");
  const buttons = (node) => typeof node !== "object" ? [] : [
    ...(node.tag === "button" ? [node] : []), ...node.children.flatMap(buttons),
  ];
  for (const services of [[], [{ name: "example" }], []]) {
    context.__test.state.services = services;
    context.__test.renderList();
    const visible = ["mcp-new-slot", "mcp-services", "mcp-empty"].flatMap((id) => buttons(elements.get(id)));
    assert.equal(visible.length, 1, "one Add button regardless of service count");
    assert.equal(visible[0].props.title, "New MCP service");
    elements.get("mcp-sidebar").events.contextmenu({ target: { closest: () => null } });
    assert.equal(lastMenu[0][0], "New MCP service…");
    assert.equal(lastMenu[0][1], visible[0].props.onclick, "button and context menu perform the same creation action");
    if (services.length) {
      elements.get("mcp-services").children[0].events.contextmenu({});
      assert.equal(lastMenu.at(-1)[1], visible[0].props.onclick);
      assert.equal(lastMenu[0][0], "Delete service");
    }
  }
});


const findNode = (node, predicate) => {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children) { const found = findNode(child, predicate); if (found) return found; }
};
const action = (id, label) => findNode(elements.get(id), (node) => node.tag === "button" && node.children.includes(label));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
function setupEditor() {
  context.activeTab = "mcp-gateway";
  Object.assign(context.__test.state, {
    selected: "example", config: { mcpconfig: { transport: "streamable-http", url: "http://example.test/mcp" }, allowlist: ["echo"], denylist: [] },
    services: [{ name: "example" }, { name: "other" }], tools: [{ name: "echo" }], session: { service: "example", id: "" },
    discovery: null, call: null, editor: null, testValues: null,
  });
  context.fetch = async (_url, init) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(init.body);
    if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : request.method === "tools/list" ? { tools: [{ name: "echo" }] } : { content: [{ type: "text", text: "answer" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "Content-Type": "application/json" } });
  };
  context.__test.renderConfig();
  context.__test.renderTest();
}

test("unsaved configuration survives leaving and reopening the same page", async () => {
  setupEditor();
  const field = elements.get("mcp-allowlist-json");
  field.value = '["echo", "draft-tool"]';
  context.api = async () => { throw new Error("must not reload over unsaved text"); };
  assert.equal(context.__test.hasEdits(), true);
  context.tabs["mcp-gateway"].hide();
  await context.__test.load("example");
  await settle();
  assert.equal(elements.get("mcp-allowlist-json"), field);
  assert.equal(field.value, '["echo", "draft-tool"]');
  assert.equal(context.__test.hasEdits(), true);
});

test("switching services preserves the draft when discard is cancelled", async () => {
  setupEditor();
  elements.get("mcp-allowlist-json").value = '["unsaved"]';
  let confirmation = "";
  context.confirmAction = async (question) => { confirmation = question; return false; };
  await context.__test.load("other");
  assert.equal(confirmation, "Discard your unsaved changes?");
  assert.equal(context.__test.state.selected, "example");
  assert.equal(context.location.hash, "#mcp-gateway/example");
  assert.equal(elements.get("mcp-allowlist-json").value, '["unsaved"]');
});

test("a completed save does not discard text typed while the write was pending", async () => {
  setupEditor();
  const field = elements.get("mcp-allowlist-json");
  field.value = '["submitted"]';
  let finish;
  context.api = () => new Promise((resolve) => { finish = resolve; });
  const save = action("mcp-config", "Save");
  const writing = save.props.onclick();
  await settle();
  assert.equal(save.disabled, true);
  field.value = '["newer-unsaved-text"]';
  finish({});
  await writing;
  await settle();
  assert.equal(field.value, '["newer-unsaved-text"]');
  assert.equal(context.__test.hasEdits(), true);
  assert.equal(save.disabled, false);
});

test("reconnecting preserves quick-test arguments and the formatted result", async () => {
  setupEditor();
  const argumentsField = elements.get("mcp-test-arguments");
  argumentsField.value = '{"text":"keep me"}';
  argumentsField.events.input();
  await action("mcp-test", "Send").props.onclick();
  const expected = context.__test.state.testValues.result;
  assert.match(expected, /answer/);
  context.__test.renderTest();
  assert.equal(elements.get("mcp-test-arguments").value, '{"text":"keep me"}');
  assert.equal(findNode(elements.get("mcp-test"), (node) => node.tag === "pre").children[0], expected);
  assert.equal(action("mcp-config", "Save").props.className, "primary");
  assert.notEqual(action("mcp-test", "Send").props.className, "primary");
});


test("a delayed list response cannot navigate back after leaving the page", async () => {
  setupEditor();
  let complete;
  context.api = () => new Promise((resolve) => { complete = resolve; });
  const loading = context.__test.refresh("other");
  context.tabs["mcp-gateway"].hide();
  context.activeTab = "policies";
  context.location.hash = "#policies";
  complete({ services: [{ name: "other" }] });
  await loading;
  assert.equal(context.location.hash, "#policies");
});

test("a failed save preserves the draft and restores the previous test connection", async () => {
  setupEditor();
  elements.get("mcp-allowlist-json").value = '["draft"]';
  let notice;
  context.setStatus = (message) => { notice = message; };
  context.api = async () => { throw new Error("Blobstore unavailable"); };
  await action("mcp-config", "Save").props.onclick();
  await settle();
  assert.equal(notice, "Not saved: Blobstore unavailable");
  assert.equal(elements.get("mcp-allowlist-json").value, '["draft"]');
  assert.equal(context.__test.hasEdits(), true);
  assert.equal(context.__test.state.session?.service, "example");
  assert.equal(action("mcp-test", "Send").disabled, false);
});


test("leaving during a tool call cancels it before deleting its session", async () => {
  setupEditor();
  context.__test.state.session = { service: "example", id: "active-session" };
  const events = [];
  context.fetch = async (_url, init) => {
    if (init.method === "DELETE") { events.push({ method: "DELETE", session: init.headers["Mcp-Session-Id"] }); return new Response(null, { status: 204 }); }
    const request = JSON.parse(init.body);
    events.push(request);
    if (request.method === "tools/call") return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); });
    });
    return new Response(null, { status: 202 });
  };
  const send = action("mcp-test", "Send");
  const running = send.props.onclick();
  assert.equal(send.disabled, true);
  await context.__test.resetConnection();
  await running;
  assert.deepEqual(events.map((e) => e.method), ["tools/call", "notifications/cancelled", "DELETE"]);
  assert.equal(events[1].params.requestId, events[0].id);
  assert.equal(events[2].session, "active-session");
  assert.equal(context.__test.state.session, null);
});

test("an obsolete discovery response cannot delete a newer service session", async () => {
  setupEditor();
  let finishList;
  const deleted = [];
  context.fetch = async (_url, init) => {
    if (init.method === "DELETE") { deleted.push(init.headers["Mcp-Session-Id"]); return new Response(null, { status: 204 }); }
    const request = JSON.parse(init.body);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return new Promise((resolve) => { finishList = () => resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }), { headers: { "Content-Type": "application/json" } })); });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }), { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "old-session" } });
  };
  const loading = context.__test.loadTools("example", context.__test.state.seq, false);
  await settle();
  context.__test.state.seq++;
  context.__test.state.selected = "other";
  context.__test.state.session = { service: "other", id: "new-session" };
  finishList();
  await loading;
  assert.equal(context.__test.state.session.id, "new-session");
  assert.deepEqual(deleted, ["old-session"]);
});
