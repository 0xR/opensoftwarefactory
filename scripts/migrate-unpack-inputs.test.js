import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("migrate-unpack-inputs.js", import.meta.url));
async function store(data, id, text, meta) {
  const object = path.join(data, "objects", id), metaFile = path.join(data, "meta", id + ".json");
  await mkdir(path.dirname(object), { recursive: true });
  await writeFile(object, text);
  if (meta === undefined) return;
  await mkdir(path.dirname(metaFile), { recursive: true });
  await writeFile(metaFile, meta);
}
const read = (data, ...parts) => readFile(path.join(data, ...parts), "utf8");
const run = data => execFileSync(process.execPath, [script, data], { stdio: "pipe" }).toString();
const metaOf = (id, size, extra = {}) => JSON.stringify({ id, size, created: "2026-11-13T20:49:22.63401027Z", creator: "ada", ...extra });

test("adds unpack_inputs to stored agent.json files, updates the metadata size and is safe to run twice", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "factory-unpack-migration-"));
  try {
    const indented = '{\n  "schema_version": 1,\n  "name": "ex",\n  "models": [\n    "m"\n  ],\n  "max_retries": 0\n}\n';
    const compact = '{"name":"demo/ex","models":["m"],"note":"ü }"}';
    const done = '{\n  "name": "done",\n  "unpack_inputs": false\n}\n';
    await store(data, "agents/ex/v1/agent.json", indented, metaOf("agents/ex/v1/agent.json", Buffer.byteLength(indented), { trace_id: "t1" }));
    await store(data, "agents/demo/ex/v2/agent.json", compact, metaOf("agents/demo/ex/v2/agent.json", Buffer.byteLength(compact)) + "\n");
    await store(data, "agents/done/v1/agent.json", done, metaOf("agents/done/v1/agent.json", Buffer.byteLength(done)));
    await store(data, "agents/empty/v1/agent.json", "{}");
    await store(data, "agents/ex/v1/systemprompt.md", "Hello!", metaOf("agents/ex/v1/systemprompt.md", 6));
    // Objects outside agents/ are not touched, whatever their name.
    await store(data, "runs/t1/agent.json", '{"a":1}', metaOf("runs/t1/agent.json", 7));

    const out = run(data);
    const wantIndented = '{\n  "schema_version": 1,\n  "name": "ex",\n  "models": [\n    "m"\n  ],\n  "max_retries": 0,\n  "unpack_inputs": true\n}\n';
    const wantCompact = '{"name":"demo/ex","models":["m"],"note":"ü }","unpack_inputs":true}';
    assert.equal(await read(data, "objects/agents/ex/v1/agent.json"), wantIndented);
    assert.equal(await read(data, "objects/agents/demo/ex/v2/agent.json"), wantCompact);
    assert.equal(await read(data, "objects/agents/done/v1/agent.json"), done);
    assert.equal(await read(data, "objects/agents/empty/v1/agent.json"), '{"unpack_inputs":true}');
    assert.equal(await read(data, "objects/runs/t1/agent.json"), '{"a":1}');
    // The size is the byte length; every other metadata field and the line end are kept.
    assert.equal(await read(data, "meta/agents/ex/v1/agent.json.json"), metaOf("agents/ex/v1/agent.json", Buffer.byteLength(wantIndented), { trace_id: "t1" }));
    assert.equal(await read(data, "meta/agents/demo/ex/v2/agent.json.json"), metaOf("agents/demo/ex/v2/agent.json", Buffer.byteLength(wantCompact)) + "\n");
    assert.equal(await read(data, "meta/agents/done/v1/agent.json.json"), metaOf("agents/done/v1/agent.json", Buffer.byteLength(done)));
    assert.equal(await read(data, "meta/agents/ex/v1/systemprompt.md.json"), metaOf("agents/ex/v1/systemprompt.md", 6));
    assert.equal(await read(data, "meta/runs/t1/agent.json.json"), metaOf("runs/t1/agent.json", 7));
    assert.match(out, /agents\/ex\/v1\/agent\.json: added "unpack_inputs": true, metadata size 89 -> 114/);
    assert.match(out, /agents\/empty\/v1\/agent\.json: added "unpack_inputs": true, no metadata file/);
    assert.match(out, /3 agent\.json files changed, 0 metadata sizes corrected, 1 already up to date/);
    assert.deepEqual(await readdir(path.join(data, "objects/agents/ex/v1")), ["agent.json", "systemprompt.md"]);

    // A second run changes nothing.
    assert.match(run(data), /^0 agent\.json files changed, 0 metadata sizes corrected, 4 already up to date\n$/);
    assert.equal(await read(data, "objects/agents/ex/v1/agent.json"), wantIndented);

    // A run that stopped before the metadata write is completed by the next run.
    await writeFile(path.join(data, "meta/agents/ex/v1/agent.json.json"), metaOf("agents/ex/v1/agent.json", 89));
    assert.match(run(data), /agents\/ex\/v1\/agent\.json: metadata size 89 -> 114\n0 agent\.json files changed, 1 metadata sizes corrected, 3 already up to date/);
    assert.equal(await read(data, "objects/agents/ex/v1/agent.json"), wantIndented);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("stops before the first write when a file or its metadata is invalid", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "factory-unpack-migration-"));
  try {
    const good = '{"name":"a"}';
    await store(data, "agents/a/v1/agent.json", good, metaOf("agents/a/v1/agent.json", 12));
    await store(data, "agents/b/v1/agent.json", "[1]");
    assert.throws(() => run(data), /agents\/b\/v1\/agent\.json is not a JSON object/);
    await writeFile(path.join(data, "objects/agents/b/v1/agent.json"), "{broken");
    assert.throws(() => run(data), /agents\/b\/v1\/agent\.json is not valid JSON/);
    await store(data, "agents/b/v1/agent.json", '{"name":"b"}', metaOf("agents/other/v1/agent.json", 12));
    assert.throws(() => run(data), /Metadata ID mismatch: agents\/b\/v1\/agent\.json/);
    assert.equal(await read(data, "objects/agents/a/v1/agent.json"), good);
    assert.equal(await read(data, "meta/agents/a/v1/agent.json.json"), metaOf("agents/a/v1/agent.json", 12));
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("a data directory without agents changes nothing", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "factory-unpack-migration-"));
  try {
    assert.match(run(data), /^0 agent\.json files changed/);
  } finally { await rm(data, { recursive: true, force: true }); }
});
