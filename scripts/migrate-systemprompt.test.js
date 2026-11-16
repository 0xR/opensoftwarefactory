import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("migrate-systemprompt.js", import.meta.url));
test("prompt migration preserves version contents and metadata and rejects conflicts before removing originals", async () => {
 const data = await mkdtemp(path.join(tmpdir(), "factory-prompt-migration-"));
 try {
  const object = path.join(data,"objects/agents/example/v1"), meta = path.join(data,"meta/agents/example/v1");
  await mkdir(object,{recursive:true}); await mkdir(meta,{recursive:true});
  const original = {id:"agents/example/v1/agent.md",created:"2026-01-01",creator:"ada",size:6};
  await writeFile(path.join(object,"agent.md"),"Hello!"); await writeFile(path.join(meta,"agent.md.json"),JSON.stringify(original));
  const run = phase => execFileSync(process.execPath,[script,phase,data],{stdio:"pipe"});
  run("prepare"); run("prepare");
  assert.equal(await readFile(path.join(object,"systemprompt.md"),"utf8"),"Hello!");
  assert.deepEqual(JSON.parse(await readFile(path.join(meta,"systemprompt.md.json"))),{...original,id:"agents/example/v1/systemprompt.md"});
  await writeFile(path.join(object,"systemprompt.md"),"conflict");
  assert.throws(()=>run("finalize"),/Conflicting prompt/);
  await access(path.join(object,"agent.md"));
  await writeFile(path.join(object,"systemprompt.md"),"Hello!"); run("finalize");
  await assert.rejects(access(path.join(object,"agent.md")),{code:"ENOENT"});
  assert.equal(await readFile(path.join(object,"systemprompt.md"),"utf8"),"Hello!");
 } finally { await rm(data,{recursive:true,force:true}); }
});
