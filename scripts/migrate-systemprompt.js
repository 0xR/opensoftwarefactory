// Two-phase filename migration: prepare before deploying the new registry, finalize afterward.
// Existing contents and metadata are preserved; conflicting destinations stop the migration.
import { readFile, writeFile, rename, unlink, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.argv[3] || path.join(root, "services/blobstore/data");
const phase = process.argv[2];
if (!["prepare", "finalize"].includes(phase)) throw new Error("Use prepare or finalize, optionally followed by the blobstore data directory");
const objects = path.join(data, "objects"), metadata = path.join(data, "meta");
async function walk(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(full));
    else if (item.isFile() && item.name === "agent.md") files.push(full);
  }
  return files;
}
async function optional(file) { try { return await readFile(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
const migrations = [];
for (const oldPath of await walk(path.join(objects, "agents"))) {
  const oldID = path.relative(objects, oldPath).split(path.sep).join("/");
  const newID = oldID.slice(0, -"agent.md".length) + "systemprompt.md";
  const body = await readFile(oldPath), oldMetaPath = path.join(metadata, oldID + ".json");
  const meta = JSON.parse(await readFile(oldMetaPath, "utf8"));
  if (meta.id !== oldID) throw new Error(`Metadata ID mismatch: ${oldID}`);
  const newPath = path.join(objects, newID), newMetaPath = path.join(metadata, newID + ".json");
  const existing = await optional(newPath), existingMeta = await optional(newMetaPath);
  const nextMeta = { ...meta, id: newID };
  if (existing && !existing.equals(body)) throw new Error(`Conflicting prompt: ${newID}`);
  if (existingMeta && JSON.stringify(JSON.parse(existingMeta)) !== JSON.stringify(nextMeta)) throw new Error(`Conflicting metadata: ${newID}`);
  if (phase === "finalize" && (!existing || !existingMeta)) throw new Error(`Migration not prepared: ${oldID}`);
  migrations.push({ oldPath, oldMetaPath, newPath, newMetaPath, body, nextMeta });
}
// Validate the entire batch before mutation. Finalize removes only byte-verified originals.
for (const m of migrations) {
  if (phase === "prepare") {
    await writeFile(m.newPath, m.body, { flag: "wx" }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const temp = m.newMetaPath + `.migration-${process.pid}`;
    await mkdir(path.dirname(m.newMetaPath), { recursive: true });
    await writeFile(temp, JSON.stringify(m.nextMeta) + "\n");
    await rename(temp, m.newMetaPath);
  } else {
    await unlink(m.oldPath);
    await unlink(m.oldMetaPath);
  }
}
console.log(`${phase}: ${migrations.length} agent prompt filenames; contents and original metadata preserved`);
