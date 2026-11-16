import { chmod, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = path.join(root, "services", "llm-gateway");
const configDirectory = path.join(service, "config");
const config = path.join(configDirectory, "config.yaml");
const template = path.join(service, "config.template");
const logs = path.join(service, "logs");

await mkdir(configDirectory, { recursive: true });
await mkdir(logs, { recursive: true });
await chmod(logs, 0o1777);

try {
  await copyFile(template, config, constants.COPYFILE_EXCL);
  console.log(`Created ${path.relative(root, config)} from config.template`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`Kept existing ${path.relative(root, config)}`);
}
