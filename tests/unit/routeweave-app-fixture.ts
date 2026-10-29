// JSON-line bridge to the actual RouteWeave app; no provider traffic or source edits.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const source = process.argv[2];
assert.ok(source, "RouteWeave source directory is required");
const [{ createApp }, { settingsFromEnv }, { examplePolicy }] = await Promise.all([
  import(pathToFileURL(resolve(source, "src/app.ts")).href),
  import(pathToFileURL(resolve(source, "src/settings.ts")).href),
  import(pathToFileURL(resolve(source, "src/schema.ts")).href),
]);
const directory = mkdtempSync("/tmp/opencode/routeweave-gateway-");
let app: ReturnType<typeof createApp> | undefined;
try {
  const settings = settingsFromEnv({
    ROUTEWEAVE_DATA_DIR: directory,
    ROUTEWEAVE_CONSUMER_TOKEN: "c".repeat(40),
    ROUTEWEAVE_OPERATOR_SECRET: "o".repeat(40),
    ROUTEWEAVE_HMAC_SECRET: "h".repeat(40),
    ROUTEWEAVE_INFERENCE_TOKEN: "i".repeat(40),
    ROUTEWEAVE_INFERENCE_URL: "http://127.0.0.1:20128/v1/systemone",
    ROUTEWEAVE_CLASSIFIER_MODEL: "classifier-a",
    ROUTEWEAVE_CLASSIFIER_NAMESPACE: "a-v1",
    ROUTEWEAVE_CLASSIFIER_CONTRACT: "contract-v1",
    ROUTEWEAVE_SERVED_MODELS: "classifier-a-dated",
    ROUTEWEAVE_EGRESS_APPROVED: "true",
    ROUTEWEAVE_INSECURE_LOCAL_COOKIE: "true",
  });
  app = createApp(settings, {
    inference: async () => ({
      domain: "code", probabilities: { code: 0.8, planning: 0.1, other: 0.1 },
      difficulty: 0.6, meta: {}, provenance: {},
    }),
  });
  const request = (method: string, path: string, payload: unknown, headers = {}) => app!.fetch(new Request(`${settings.origin}${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
  }));
  const origin = { Origin: settings.origin };
  const login = await request("POST", "/operator/login", { secret: settings.operatorSecret }, origin);
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Operator login must set a session cookie");
  const operator = { ...origin, Cookie: cookie, "X-CSRF-Token": (await login.json()).csrf_token };
  const policy = examplePolicy();
  // Force the failing route first; do not depend on candidate tie-breaking.
  policy.default.candidates = {
    "openai/a": { ...policy.default.neutral, base: 1 },
    "openai/b": { ...policy.default.neutral, base: 0 },
  };
  const draft = await request("PUT", "/operator/draft", { document: policy, version: 0 }, operator);
  assert.equal(draft.status, 200, await draft.clone().text());
  const published = await request("POST", "/operator/publish", { version: (await draft.json()).version }, operator);
  assert.equal(published.status, 200, await published.clone().text());
  console.log(JSON.stringify({ ready: true }));
  for await (const line of createInterface({ input: process.stdin })) {
    const incoming = JSON.parse(line);
    assert.ok(["/v1/decisions", "/v1/outcomes"].includes(incoming.path));
    const response = await request("POST", incoming.path, incoming.payload, incoming.headers);
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  }
} finally {
  try { await app?.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
