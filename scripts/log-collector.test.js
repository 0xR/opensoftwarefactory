import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const base = new URL("../infra/kubernetes/base/log-collector/", import.meta.url);
const config = fs.readFileSync(new URL("config.yaml", base), "utf8");
const daemonset = fs.readFileSync(new URL("daemonset.yaml", base), "utf8");
const rbac = fs.readFileSync(new URL("rbac.yaml", base), "utf8");
const service = fs.readFileSync(new URL("service.yaml", base), "utf8");
const justfile = fs.readFileSync(new URL("../justfile", import.meta.url), "utf8");
const openobserveInit = fs.readFileSync(new URL("init-openobserve.js", new URL("../scripts/", import.meta.url)), "utf8");

test("collector tails only factory logs and forwards buffered redacted JSON", () => {
  assert.match(config, /Path\s+\/var\/log\/containers\/\*_opensoftwarefactory_\*\.log/);
  assert.match(config, /Exclude_Path\s+\/var\/log\/containers\/log-collector-/);
  assert.match(config, /Merge_Log\s+On/);
  assert.match(config, /storage\.type\s+filesystem/);
  assert.match(config, /Inotify_Watcher\s+False/);
  assert.match(config, /@INCLUDE \/credentials\/fluent-bit-output\.conf/);
  assert.match(config, /value\[key\] = "\[REDACTED\]"/);
  assert.match(config, /POST \/api\/default\/factory\/_json/);
  assert.match(config, /return -1, timestamp, record/);
});

test("collector uses mounted credentials without committing them", () => {
  assert.match(daemonset, /fluent-bit-output\.conf|mountPath: \/credentials/);
  assert.match(daemonset, /path: \/openobserve\/config/);
  assert.doesNotMatch(daemonset, /admin@example\.com|ZO_ROOT_USER_PASSWORD=/);
  assert.match(daemonset, /readOnlyRootFilesystem: true/);
  assert.match(daemonset, /sha256:[a-f0-9]{64}/);
});

test("collector metadata access is namespace scoped", () => {
  assert.match(rbac, /kind: Role\n/);
  assert.doesNotMatch(rbac, /ClusterRole/);
  assert.match(rbac, /resources: \["pods"\]/);
});

test("collector exposes internal health and pipeline metrics without restart-on-outage behavior", () => {
  assert.match(config, /HTTP_Server\s+On/);
  assert.match(config, /HTTP_Listen\s+0\.0\.0\.0/);
  assert.match(config, /HTTP_Port\s+2020/);
  assert.match(config, /Health_Check\s+On/);
  assert.match(config, /HC_Errors_Count\s+5/);
  assert.match(config, /HC_Retry_Failure_Count\s+5/);
  assert.match(config, /HC_Period\s+60/);
  assert.match(config, /storage\.metrics\s+On/);
  assert.match(daemonset, /name: metrics\n\s+containerPort: 2020/);
  assert.match(daemonset, /readinessProbe:\n\s+httpGet:\n\s+path: \/\n\s+port: metrics/);
  assert.match(daemonset, /livenessProbe:\n\s+tcpSocket:\n\s+port: metrics/);
  assert.match(service, /type: ClusterIP/);
  assert.match(service, /port: 2020/);
  assert.match(service, /targetPort: metrics/);
  assert.doesNotMatch(service, /NodePort|LoadBalancer|externalIPs/);
  assert.match(openobserveInit, /Alias\s+openobserve/);
});

test("project lifecycle waits for the collector without deleting it on stop", () => {
  assert.match(justfile, /rollout status daemonset\/log-collector/);
  assert.doesNotMatch(justfile, /delete daemonset log-collector/);
  assert.match(justfile, /docker stop \$nodes/);
});
