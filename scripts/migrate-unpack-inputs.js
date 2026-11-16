// One-time migration: adds "unpack_inputs": true to every stored agent.json that lacks it,
// and sets the size in the object's metadata. The rest of each file stays as it is.
// It is safe to run twice: a file that has the field is left alone.
// Usage: node scripts/migrate-unpack-inputs.js [blobstore data directory]
import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.argv[2] || path.join(root, "services/blobstore/data");
const objects = path.join(data, "objects"), metadata = path.join(data, "meta");
async function walk(dir) {
  const files = [];
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return files; throw e; }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(full));
    else if (item.isFile() && item.name === "agent.json") files.push(full);
  }
  return files.sort();
}
async function optional(file) { try { return await readFile(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
// withField adds the field as the last member and keeps the text before it unchanged.
function withField(text, definition) {
  const end = text.lastIndexOf("}");
  const body = text.slice(0, end).trimEnd(), tail = text.slice(end + 1);
  const indent = (text.match(/\n([ \t]+)"/) || [])[1];
  const member = indent === undefined ? '"unpack_inputs":true' : `\n${indent}"unpack_inputs": true\n`;
  const next = body + (body.endsWith("{") ? "" : ",") + member + "}" + tail;
  const want = JSON.stringify({ ...definition, unpack_inputs: true });
  // A file with an unusual layout is written again with two spaces instead.
  try { if (JSON.stringify(JSON.parse(next)) === want) return next; } catch { /* fall through */ }
  return JSON.stringify({ ...definition, unpack_inputs: true }, null, 2) + "\n";
}
async function replace(file, text) {
  const temp = `${file}.migration-${process.pid}`;
  await writeFile(temp, text);
  await rename(temp, file);
}
// Read and check every file before the first write.
const changes = [];
let unchanged = 0;
for (const file of await walk(path.join(objects, "agents"))) {
  const id = path.relative(objects, file).split(path.sep).join("/");
  const text = await readFile(file, "utf8");
  let definition;
  try { definition = JSON.parse(text); } catch (e) { throw new Error(`${id} is not valid JSON: ${e.message}`); }
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`${id} is not a JSON object`);
  const has = Object.hasOwn(definition, "unpack_inputs");
  const next = has ? text : withField(text, definition);
  const size = Buffer.byteLength(next);
  const metaFile = path.join(metadata, id + ".json"), metaText = await optional(metaFile);
  let meta = null;
  if (metaText !== null) {
    try { meta = JSON.parse(metaText); } catch (e) { throw new Error(`Metadata of ${id} is not valid JSON: ${e.message}`); }
    if (meta.id !== id) throw new Error(`Metadata ID mismatch: ${id}`);
  }
  // A run that stopped between the two writes leaves a stale size; it is corrected here.
  const fixSize = meta !== null && meta.size !== size;
  if (has && !fixSize) { unchanged++; continue; }
  changes.push({ id, file, text, next, has, metaFile, metaText, meta, size, fixSize });
}
for (const c of changes) {
  if (!c.has) await replace(c.file, c.next);
  if (c.fixSize) await replace(c.metaFile, JSON.stringify({ ...c.meta, size: c.size }) + (c.metaText.endsWith("\n") ? "\n" : ""));
  const parts = [];
  if (!c.has) parts.push('added "unpack_inputs": true');
  if (c.fixSize) parts.push(`metadata size ${c.meta.size} -> ${c.size}`);
  if (c.meta === null) parts.push("no metadata file");
  console.log(`${c.id}: ${parts.join(", ")}`);
}
console.log(`${changes.filter(c => !c.has).length} agent.json files changed, ${changes.filter(c => c.has).length} metadata sizes corrected, ${unchanged} already up to date`);
