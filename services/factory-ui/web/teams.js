"use strict";
// Team view: a team step of a run, read-only. The sidebar lists the team's channels (the two
// member names and the number of messages) and its members with the lead marked; the middle
// has one tab per open channel (its chat log) and per open file, then the status line as on
// Runs; the right column lists the workspace files (see chat.js for the tabs and the file
// viewer). It has no menu item: Runs and Decisions link to it, and Runs stays the active page.
// While the team runs it follows the blobstore every 3 seconds.
// Hash: #teams/<trace>/<step...>?channel=<channel id>, the team's blob path without teams/.
//
// Storage (blobstore, read through /api/blobs): <team>/team.json, <team>/files/<name>,
// <team>/finished.json, and a channel as one queue per sender, <team>/channels/<id>/<sender>.json
// ({"channel","from","to","messages":[{"seq","text","sent"}]}, seq counting per queue), shown as
// one chat; teams of earlier runs keep a channel whole in <team>/channels/<id>.json
// ({"id","members","messages":[{"seq","from","text","sent"}]}). Running teams: GET /api/orchestrator/teams.

// ---- Logic without the DOM (covered by teams_ui_test.mjs) ----

const TeamsLogic = (() => {
  const TEAM = /^teams(\/[A-Za-z0-9_-][A-Za-z0-9._-]*){2,}$/;
  const ROUND = /^(.+)\.([1-9][0-9]*)$/;
  const WORKFLOW = "workflow"; // the reserved member: the orchestrator, which posts the task and rejections

  const validTeam = (team) => typeof team === "string" && team.length <= 400 && TEAM.test(team);

  // A team's path is teams/<trace>/<step>, with the steps of the workflow nodes above it between.
  const teamPath = (trace, step) => `teams/${trace}/${step}`;
  const traceOf = (team) => String(team).split("/")[1] || "";
  const stepOf = (team) => String(team).split("/").slice(2).join("/");

  // A team opens at #teams/<trace>/<step...>, optionally on one channel.
  const teamHash = (team, channel = "") => `#teams/${String(team).replace(/^teams\//, "")}${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`;
  function teamFromHash(rest) {
    const [path, query = ""] = String(rest || "").split("?");
    const team = `teams/${path.replace(/^\/+|\/+$/g, "")}`;
    let channel = /(?:^|&)channel=([^&]*)/.exec(query)?.[1] || "";
    try { channel = decodeURIComponent(channel); } catch { /* kept as typed */ }
    return { team: validTeam(team) ? team : "", channel };
  }

  // manifest reads the output of a team step, {"summary","team","files":[{"name","artifact"}]};
  // null for any other text.
  function manifest(text) {
    let doc;
    try { doc = JSON.parse(text); } catch { return null; }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || !validTeam(doc.team) || !Array.isArray(doc.files)) return null;
    const files = doc.files
      .filter((f) => f && typeof f.name === "string" && f.name && typeof f.artifact === "string" && f.artifact)
      .map((f) => ({ name: f.name, artifact: f.artifact }));
    return { summary: typeof doc.summary === "string" ? doc.summary : "", team: doc.team, files };
  }

  // A result file is Markdown, JSON, or plain text by its extension; anything else is code.
  function documentKind(name) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(String(name))?.[1]?.toLowerCase() || "";
    return ext === "md" ? "markdown" : ext === "json" ? "json" : ext === "txt" ? "text" : "code";
  }

  // A channel is named by its two members: the orchestrator first, then the lead, then by name.
  function channelMembers(channel, lead = "") {
    const members = Array.isArray(channel?.members) && channel.members.length ? channel.members.map(String) : String(channel?.id || "").split("--");
    const rank = (m) => (m === WORKFLOW ? 0 : m === lead ? 1 : 2);
    return [...members].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  // A one-way channel (team.json names its only sender as "from") reads "sender → receiver".
  function channelLabel(channel, lead = "") {
    const members = channelMembers(channel, lead);
    const from = String(channel?.from || "");
    return members.includes(from) ? `${from} → ${members.find((m) => m !== from)}` : members.join(" ↔ ");
  }

  // defOf finds the definition a workflow reference names ("name" or "name@vN", see
  // workflowref.js): that version when the list holds it, else the first of that name. The list
  // has the newest definitions first, so a bare name finds the newest.
  function defOf(defs, ref) {
    const all = (Array.isArray(defs) ? defs : []).filter(Boolean);
    const { name, version } = WorkflowRef.parse(ref);
    return (version && all.find((w) => w.name === name && Number(w.version) === version)) || all.find((w) => w.name === name);
  }

  // teamSteps names the team steps a run of a workflow has, those of its nested workflows as
  // "<node>/<step>", from the definitions; none while the definitions are not loaded.
  function teamSteps(defs, name, prefix = "", depth = 0) {
    const def = defOf(defs, name);
    if (!def || depth > 8) return [];
    return (def.steps || []).flatMap((s) => (s.service === "team" ? [prefix + s.id]
      : s.service === "workflow" ? teamSteps(defs, s.workflow, `${prefix}${s.id}/`, depth + 1) : []));
  }

  // channels lists a team's channels from team.json and the stored channel logs (the task
  // channel of the lead is only among the logs), each with its message count: the task channel
  // first, then the lead's channels, then the others, by name.
  function channels(team, logs = []) {
    const lead = String(team?.lead || "");
    const byId = new Map();
    for (const c of Array.isArray(team?.channels) ? team.channels : []) {
      if (c && c.id) byId.set(String(c.id), { id: String(c.id), members: channelMembers(c, lead), ...(c.from ? { from: String(c.from) } : {}), count: 0 });
    }
    for (const log of logs) {
      if (!log || !log.id) continue;
      const id = String(log.id);
      const entry = byId.get(id) || { id, members: channelMembers(log, lead), count: 0 };
      entry.count = Array.isArray(log.messages) ? log.messages.length : 0;
      byId.set(id, entry);
    }
    const rank = (c) => (c.members.includes(WORKFLOW) ? 0 : c.members.includes(lead) ? 1 : 2);
    return [...byId.values()].map((c) => ({ ...c, label: channelLabel(c, lead) }))
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }

  // members lists the team's members, the lead first, then as stored.
  function members(team) {
    const lead = String(team?.lead || "");
    const list = (Array.isArray(team?.members) ? team.members : []).filter((m) => m && m.name)
      .map((m) => ({ name: String(m.name), kind: m.kind === "workflow" ? "workflow" : "agent", ref: String(m.ref || ""), description: String(m.description || ""), lead: String(m.name) === lead }));
    return [...list.filter((m) => m.lead), ...list.filter((m) => !m.lead)];
  }

  // messages returns a channel log's messages in the order they were sent: by seq, or as merged
  // from the queues of its two senders (see channelLog), where seq counts per sender.
  function messages(log) {
    const list = (Array.isArray(log?.messages) ? log.messages : []).filter((m) => m && typeof m === "object")
      .map((m) => ({ seq: Number(m.seq) || 0, from: String(m.from || ""), text: typeof m.text === "string" ? m.text : String(m.text ?? ""), sent: String(m.sent || "") }));
    return log?.merged ? list : list.sort((a, b) => a.seq - b.seq);
  }

  // channelSources tells the two ways a channel is stored apart in the listing of
  // <team>/channels: a directory <id> holds one queue per sender, an object <id>.json is a
  // channel stored whole (teams of earlier runs). A channel found both ways is read from its queues.
  function channelSources(listing) {
    const dirs = [...new Set((Array.isArray(listing?.directories) ? listing.directories : [])
      .map((d) => String(d).replace(/\/+$/, "").split("/").pop()).filter(Boolean))];
    const files = (Array.isArray(listing?.objects) ? listing.objects : [])
      .map((x) => ({ id: /\/([^/]+)\.json$/.exec(String(x?.id || ""))?.[1] || "", version: `${x?.created}|${x?.size}`, object: String(x?.id || "") }))
      .filter((x) => x.id && !dirs.includes(x.id));
    return { dirs, files };
  }

  // queueSources names the queues in the listing of a channel's directory, <sender>.json each,
  // by sender; version changes when a queue was written again.
  function queueSources(channel, objects) {
    return (Array.isArray(objects) ? objects : [])
      .map((x) => ({ channel: String(channel), sender: /\/([^/]+)\.json$/.exec(String(x?.id || ""))?.[1] || "", version: `${x?.created}|${x?.size}`, object: String(x?.id || "") }))
      .filter((x) => x.sender)
      .sort((a, b) => a.sender.localeCompare(b.sender));
  }

  // mergeQueues makes one chat of a channel's queues ({"from","messages":[{"seq","text","sent"}]}):
  // by the time sent, every message with its sender. A queue keeps its seq order whatever its
  // times say, and of two messages sent at the same time the one of the earlier queue comes first.
  function mergeQueues(queues) {
    const lists = (Array.isArray(queues) ? queues : []).filter((q) => q && typeof q === "object").map((q) => {
      let last = -Infinity; // a message without a time follows the one before it in its queue
      return messages({ messages: q.messages }).map((m) => {
        const at = Date.parse(m.sent);
        if (!Number.isNaN(at)) last = at;
        return { at: last, message: { ...m, from: String(q.from || m.from || "") } };
      });
    });
    const next = lists.map(() => 0), out = [];
    for (;;) {
      let pick = -1;
      for (let i = 0; i < lists.length; i++) {
        if (next[i] < lists[i].length && (pick < 0 || lists[i][next[i]].at < lists[pick][next[pick]].at)) pick = i;
      }
      if (pick < 0) return out;
      out.push(lists[pick][next[pick]++].message);
    }
  }

  // channelLog is a channel read from its queues, shaped like a channel stored whole: named by
  // the two ends of a queue (by its ID while it has none), with the merged chat. A queue that
  // is missing is empty.
  function channelLog(id, queues) {
    const list = (Array.isArray(queues) ? queues : []).filter((q) => q && typeof q === "object");
    const ends = list.find((q) => q.from && q.to);
    return { id: String(id), ...(ends ? { members: [String(ends.from), String(ends.to)] } : {}), messages: mergeQueues(list), merged: true };
  }

  // A gate that sends rejections back to a team is reviewed in rounds; the first has no label.
  const roundLabel = (round) => (Number(round) >= 2 ? `Round ${Math.floor(Number(round))}` : "");

  // Earlier decisions of such a gate are kept beside its record as <artifact>.<n>.
  const isRoundRecord = (id) => ROUND.test(String(id));
  function roundOf(id) {
    const found = ROUND.exec(String(id));
    return found ? { artifact: found[1], round: Number(found[2]) } : { artifact: String(id), round: 0 };
  }
  // roundRecords picks the earlier decision records of a gate out of object IDs, oldest first;
  // before limits them to the rounds ahead of round `before`.
  function roundRecords(artifact, ids, before = Infinity) {
    return (ids || []).map((id) => ({ id: String(id), ...roundOf(id) }))
      .filter((r) => r.round > 0 && r.artifact === artifact && r.round < before)
      .map(({ id, round }) => ({ id, round }))
      .sort((a, b) => a.round - b.round);
  }

  // stepAt finds the definition of a step by its path in a run: "build/team" is the step team
  // of the workflow that the workflow node build runs. null when a definition is not known.
  function stepAt(defs, workflow, path) {
    const all = Array.isArray(defs) ? defs : [];
    let def = defOf(all, workflow), step = null;
    const parts = String(path).split("/");
    for (let i = 0; i < parts.length; i++) {
      step = def?.steps?.find((s) => s.id === parts[i]) || null;
      if (!step) return null;
      if (i < parts.length - 1) def = step.service === "workflow" ? defOf(all, step.workflow) : null;
    }
    return step;
  }

  // stepRows lists the rows of a run's step list: the top-level steps in the given order, and
  // under every workflow node the steps of its nested workflow ("<node>/<step>", any depth):
  // those in observed (paths that left an object in the run) and, with defined, the rest of the
  // nested definition. The children of a route step stay out, as before.
  function stepRows(top, observed, defs, workflow, defined = false) {
    const all = Array.isArray(defs) ? defs : [];
    const seen = new Set(), rows = [], paths = new Set();
    for (const path of observed || []) {
      if (isRoundRecord(path)) continue;
      const parts = String(path).split("/");
      for (let i = 2; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
    }
    const add = (id, depth) => {
      if (seen.has(id) || depth > 8) return;
      seen.add(id);
      rows.push({ id, depth });
      const step = stepAt(all, workflow, id);
      if (step?.service !== "workflow") return;
      const child = defOf(all, step.workflow);
      const kids = (child?.steps || []).map((s) => `${id}/${s.id}`).filter((p) => defined || paths.has(p));
      const extra = [...paths].filter((p) => p.startsWith(`${id}/`) && !p.slice(id.length + 1).includes("/") && !kids.includes(p)).sort();
      for (const p of [...kids, ...extra]) add(p, depth + 1);
    };
    for (const id of top || []) if (!isRoundRecord(id)) add(id, 0);
    return rows;
  }

  // hasFinished finds the lead's finish record among the objects directly in the team's folder.
  const hasFinished = (team, ids) => (ids || []).includes(`${team}/finished.json`);

  // reloadDue says whether the team view reads the team again at a tick: always while it runs
  // (or has not loaded), at once when it starts or stops running (a finished team runs again
  // after a rejection), and otherwise at every idleTicks-th tick.
  function reloadDue(was, running, loaded, ticks, idleTicks = 5) {
    return !!running || !!was !== !!running || !loaded || ticks % idleTicks === 0;
  }

  // failedPaths names the steps a failed run's error passes through, outermost first:
  // 'step "build": ... step "team"' fails build and build/team.
  function failedPaths(error) {
    const steps = [...String(error || "").matchAll(/step "([^"]+)"/g)].map((m) => m[1]);
    return steps.map((_, i) => steps.slice(0, i + 1).join("/"));
  }

  return {
    validTeam, teamPath, traceOf, stepOf, teamHash, defOf, teamSteps, teamFromHash, manifest, documentKind, channelMembers, channelLabel, channels, members,
    messages, channelSources, queueSources, mergeQueues, channelLog, roundLabel, isRoundRecord, roundOf, roundRecords, stepAt, stepRows, failedPaths, reloadDue, hasFinished,
  };
})();

// ---- Running teams (asked by Runs and by the team view) ----

const teamsState = { running: [], loaded: false };

async function refreshTeams() {
  try {
    teamsState.running = (await api("GET", "/api/orchestrator/teams")).teams || [];
    teamsState.loaded = true;
  } catch { /* the last answer stays; a team that is not listed is shown as not running */ }
}
const teamRunning = (team) => teamsState.running.some((t) => t.team === team);

// ---- The team view ----

(() => {
  if (typeof document === "undefined" || !document.getElementById("tab-teams")) return;
  const POLL_MS = 3000;
  const IDLE_TICKS = 5; // a team that does not run is read again every 15 s (a rejection restarts it)
  const state = { generation: 0, team: "", want: "", opened: false, controller: null, timer: null, ticks: 0, info: null, logs: new Map(), docs: new Map(), finished: false, loaded: false, loading: 0, error: "", listKey: null };
  const views = new Map(); // channel id -> { history, pane, nodes, key, atEnd }
  const channelList = $("team-channels");
  const listState = $("team-list-state");
  const memberList = $("team-members");
  const membersTitle = $("teamview-members-title");
  const main = $("team-main");
  const files = $("team-files");

  const tabId = (channel) => `channel:${channel}`;
  const channels = () => TeamsLogic.channels(state.info, [...state.logs.values()].map((l) => l.log));

  // readJSON returns a stored JSON document, or null when there is none (or it does not parse).
  async function readJSON(id) {
    const res = await fetch(`/api/blobs/blobs/${id}`);
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(errorMessage(text, res));
    try { return JSON.parse(text); } catch { return null; }
  }
  async function listPrefix(prefix) {
    try { return await api("GET", `/api/blobs/list/${prefix}`); }
    catch (e) { if (e.status === 404 || /not found/i.test(e.message)) return { directories: [], objects: [] }; throw e; }
  }
  const listObjects = async (prefix) => (await listPrefix(prefix)).objects || [];

  // The team's state: running while the orchestrator lists it, completed once the lead finished it.
  function chip() {
    if (teamRunning(state.team)) return statusChip("running");
    if (!state.loaded) return statusChip("idle", "…");
    if (state.finished) return statusChip("done");
    // A run that failed took its team with it: the team stalled, used its turns, or a turn failed.
    if (runIndex.statuses.get(TeamsLogic.traceOf(state.team))?.status === "Failed") return statusChip("failed");
    return statusChip("idle", "Idle", "The team is not running and its lead has not finished it");
  }

  // ---- Sidebar ----

  function renderList(force = false) {
    const list = channels(), people = TeamsLogic.members(state.info);
    const active = state.controller?.activeTab() || "";
    const problem = state.error && !state.loaded ? state.error : "";
    const key = JSON.stringify([list, people, active, problem, state.loaded]);
    if (!force && key === state.listKey) return;
    state.listKey = key;
    fill(listState, problem ? errorPanel(problem) : state.loaded && !list.length ? emptyPanel("No channels") : null);
    channelList.replaceChildren(...list.map((c) => {
      const li = h("li", { role: "option", tabIndex: 0, "aria-selected": String(active === tabId(c.id)) },
        h("div", { className: "row-title", dataset: { full: c.label } }, c.label),
        h("span", { className: "teamview-count", title: `${c.count} message${c.count === 1 ? "" : "s"}` }, String(c.count)));
      const pick = () => {
        const want = TeamsLogic.teamHash(state.team, c.id);
        if (location.hash === want) openChannel(c.id); else location.hash = want;
      };
      li.addEventListener("click", pick);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); }
        if (ev.key === "ArrowDown") li.nextElementSibling?.focus();
        if (ev.key === "ArrowUp") li.previousElementSibling?.focus();
      });
      li.addEventListener("contextmenu", (ev) => ev.preventDefault()); // a row without actions shows no menu
      return li;
    }));
    membersTitle.hidden = !people.length;
    memberList.replaceChildren(...people.map((m) => h("li", { title: [m.ref, m.description].filter(Boolean).join(" · ") || undefined },
      h("div", { className: "row-title", dataset: { full: m.name } }, m.name),
      m.lead ? h("span", { className: "teamview-count" }, "Lead") : null)));
  }

  // ---- Channel logs ----

  function toEnd(v) {
    v.history.scrollTop = v.history.scrollHeight;
    v.atEnd = true;
  }

  function view(id) {
    let v = views.get(id);
    if (!v) {
      const history = h("div", { className: "chat-history", role: "log", tabIndex: 0 });
      v = { id, history, pane: h("div", { className: "chat-pane", role: "tabpanel" }, history), nodes: [], key: null, atEnd: true };
      history.addEventListener("scroll", () => {
        if (history.clientHeight) v.atEnd = history.scrollHeight - history.scrollTop - history.clientHeight < 48;
      });
      views.set(id, v);
    }
    return v;
  }

  // Every message names its sender; the lead is marked, as in the sidebar.
  function messageNode(v, m) {
    const resized = () => { if (v.atEnd) toEnd(v); };
    return h("div", { className: "chat-message assistant" },
      h("div", { className: "chat-author" },
        h("span", {}, m.from || "Unknown"),
        m.from && m.from === state.info?.lead ? h("span", { className: "teamview-lead" }, "Lead") : null,
        m.sent ? timeEl(m.sent) : null,
        copyButton(m.text, "message")),
      InteractiveSession.renderMarkdown(m.text, resized));
  }

  // renderView draws a channel's log. A log only grows, so the nodes of messages already shown
  // are kept (a drawn diagram is not drawn again), and the view stays at the end when it was there.
  function renderView(v) {
    const list = TeamsLogic.messages(state.logs.get(v.id)?.log);
    const key = JSON.stringify(list);
    if (key === v.key) return;
    v.key = key;
    const stick = v.atEnd;
    v.nodes = list.map((m, i) => {
      const k = JSON.stringify(m);
      return v.nodes[i]?.key === k ? v.nodes[i] : { key: k, node: messageNode(v, m) };
    });
    v.history.replaceChildren(...(v.nodes.length ? v.nodes.map((n) => n.node) : [emptyPanel("No messages yet")]));
    if (stick) toEnd(v);
  }

  function openChannel(id) {
    const channel = channels().find((c) => c.id === id);
    if (!channel || !state.controller) return false;
    const v = view(id);
    v.history.setAttribute("aria-label", `Messages between ${channel.members.join(" and ")}`);
    renderView(v);
    state.opened = true;
    state.controller.openView(tabId(id), channel.label, v.pane);
    return true;
  }

  // The channel the hash asks for opens once the team has loaded; without one, the first channel.
  function openWanted() {
    if (!state.loaded || !state.controller) return;
    const list = channels();
    if (state.want && openChannel(state.want)) { state.want = ""; return; }
    if (state.want && list.length) state.want = ""; // a channel that does not exist gives way to the first
    if (!state.opened && list.length) openChannel(list[0].id);
  }

  // The open tab is the selection: the sidebar and the hash follow it.
  function onActivate(id) {
    renderList();
    const v = id.startsWith("channel:") ? views.get(id.slice(8)) : null;
    if (v?.atEnd) toEnd(v);
    if (activeTab !== "teams" || !state.opened || !state.team) return;
    const want = TeamsLogic.teamHash(state.team, v ? v.id : "");
    if (location.hash !== want) history.replaceState(null, "", want);
  }

  // ---- Loading ----

  function open(team) {
    state.controller?.destroy();
    views.clear();
    state.logs = new Map();
    state.docs = new Map();
    // A new generation: a load of the team shown before is dropped, and this team is read at once.
    Object.assign(state, { generation: state.generation + 1, loading: 0, team, opened: false, info: null, finished: false, loaded: false, error: "", listKey: null, ticks: 0 });
    state.controller = InteractiveSession.mount(main, {
      session: team, traceId: TeamsLogic.traceOf(team), step: TeamsLogic.stepOf(team), filesContainer: files,
      closed: true, workspaceOnly: true, emptyTitle: () => (state.loaded ? "No channels" : ""), chip, onActivate, // not "No channels" before the team was read
      time: () => runIndex.records.get(TeamsLogic.traceOf(team))?.started || "", // the run's start, as on Sessions
    });
    // A team opened by its link, before any run was listed: the status line gets its time once the runs are known.
    if (!runIndex.records.has(TeamsLogic.traceOf(team))) runIndex.refresh().then(() => { if (state.team === team) state.controller?.renderMeta(); }, () => {});
    renderList(true);
    reserveToggles();
    load();
  }

  // load reads the team as the blobstore has it. The listings say what changed: one of the
  // channels, one per channel stored as queues, and only a queue (or a channel stored whole)
  // that was written since is read again.
  async function load(ask = true) {
    const team = state.team, generation = state.generation;
    if (!team || state.loading === generation) return;
    state.loading = generation;
    try {
      // Whether the team runs is asked beside the read, never before it: a slow orchestrator must not hold up the blobstore.
      if (ask) refreshTeams().then(() => { if (state.generation === generation) state.controller?.renderMeta(); });
      // finished.json is looked for in the listing, not fetched: a team that has not finished has none.
      const [info, listing, own] = await Promise.all([readJSON(`${team}/team.json`), listPrefix(`${team}/channels`), listObjects(team)]);
      const finished = TeamsLogic.hasFinished(team, own.map((x) => x.id));
      const { dirs, files: whole } = TeamsLogic.channelSources(listing);
      // A directory that cannot be listed now keeps the queues read before.
      const listed = await pool(dirs, 4, async (id) => {
        try { return TeamsLogic.queueSources(id, await listObjects(`${team}/channels/${id}`)); } catch { return null; }
      });
      if (state.generation !== generation) return;
      const queues = dirs.map((id, i) => listed[i] || [...state.docs.values()].filter((d) => d.channel === id));
      const stored = [...whole, ...queues.flat()];
      const read = await pool(stored.filter((x) => state.docs.get(x.object)?.version !== x.version), 4, async (x) => {
        try { return { ...x, doc: await readJSON(x.object) }; } catch { return null; }
      });
      if (state.generation !== generation) return;
      for (const x of read) if (x?.doc) state.docs.set(x.object, x);
      const present = new Set(stored.map((x) => x.object));
      for (const object of [...state.docs.keys()]) if (!present.has(object)) state.docs.delete(object);
      // The channels as shown: one stored whole as it is, one stored as queues merged into one chat.
      const logs = new Map();
      for (const x of whole) if (state.docs.has(x.object)) logs.set(x.id, { log: { ...state.docs.get(x.object).doc, id: x.id } });
      dirs.forEach((id, i) => logs.set(id, { log: TeamsLogic.channelLog(id, queues[i].map((q) => state.docs.get(q.object)).filter(Boolean).map((q) => ({ ...q.doc, from: q.doc.from || q.sender }))) }));
      state.logs = logs;
      if (info) state.info = info;
      state.finished = finished;
      // The run's status tells a failed team from an idle one; status only, no listing.
      if (!finished) runIndex.status(TeamsLogic.traceOf(state.team), 3000, "").then(() => { if (state.generation === generation) state.controller?.renderMeta(); }, () => {});
      state.loaded = true;
      state.error = "";
    } catch (e) {
      if (state.generation === generation) state.error = `Cannot load the team: ${e.message}`;
    } finally { if (state.loading === generation) state.loading = 0; }
    if (state.generation !== generation) return;
    renderList();
    for (const v of views.values()) renderView(v);
    state.controller?.renderMeta();
    state.controller?.renderEmpty();
    openWanted();
  }

  // tick asks the orchestrator every time whether the team runs: a team that had finished runs
  // again after a rejection, and then the chip, the channels, and the files follow at once.
  async function tick() {
    if (document.hidden || !state.team || state.asking) return;
    const team = state.team, was = teamRunning(team);
    state.ticks++;
    state.asking = true;
    try { await refreshTeams(); } finally { state.asking = false; }
    if (state.team !== team) return;
    const running = teamRunning(team);
    if (running !== was) state.controller?.renderMeta();
    if (!TeamsLogic.reloadDue(was, running, state.loaded, state.ticks, IDLE_TICKS)) return;
    load(false);
    if (running || was) state.controller?.refresh(); // the files the members write
  }
  // Coming back to the window or the tab checks at once, not at the next tick.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && activeTab === "teams") tick(); });
  window.addEventListener("focus", () => { if (activeTab === "teams") tick(); });

  tabs.teams = {
    async show(rest) {
      const asked = TeamsLogic.teamFromHash(rest);
      let team = asked.team || state.team;
      if (!team) {
        // The bare page opens a team that runs; without one there is nothing to show here.
        await refreshTeams();
        team = teamsState.running.map((t) => t.team).find(TeamsLogic.validTeam) || "";
        if (activeTab !== "teams") return;
        if (!team) { location.replace("#runs"); return; }
      }
      state.want = asked.channel;
      if (team !== state.team) open(team);
      else openWanted();
      if (!asked.team) history.replaceState(null, "", TeamsLogic.teamHash(team, state.want));
      if (state.timer) return;
      state.timer = setInterval(tick, POLL_MS);
    },
    hide() {
      clearInterval(state.timer);
      state.timer = null;
    },
  };
})();
