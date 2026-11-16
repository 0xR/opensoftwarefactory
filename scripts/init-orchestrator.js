import { chmod, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = path.join(root, "services", "orchestrator");
const configDirectory = path.join(service, "config");
const config = path.join(configDirectory, "config.yaml");
const template = path.join(service, "config.template");

// The web UI replaces config.yaml by renaming a temporary file into this
// directory, so the unprivileged container user needs non-sticky write access.
await mkdir(configDirectory, { recursive: true });
await chmod(configDirectory, 0o777);

// KIND's container UID differs from the host owner, so the blobstore data
// directory gets sticky shared-write permissions like the gateway logs.
const blobData = path.join(root, "services", "blobstore", "data");
await mkdir(blobData, { recursive: true });
await chmod(blobData, 0o1777);

try {
  await copyFile(template, config, constants.COPYFILE_EXCL);
  await chmod(config, 0o666);
  console.log(`Created ${path.relative(root, config)} from config.template`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`Kept existing ${path.relative(root, config)}`);
}
