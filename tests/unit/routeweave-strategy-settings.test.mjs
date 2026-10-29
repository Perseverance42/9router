import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../src/app/(dashboard)/dashboard/combos/page.js", import.meta.url), "utf8");
const settingsRoute = readFileSync(new URL("../../src/app/api/settings/route.js", import.meta.url), "utf8");

// Exercise the existing page handlers without loading React/Next or replacing their logic.
function pageHandler(name, bindings) {
  const start = page.indexOf(`  const ${name} = `);
  assert.notEqual(start, -1);
  const end = page.indexOf("\n  };", start);
  assert.notEqual(end, -1);
  const expression = page.slice(start + `  const ${name} = `.length, end + 4);
  return new Function(...Object.keys(bindings), `return ${expression}`)(...Object.values(bindings));
}

function strategyWriter() {
  const writes = [];
  const states = [];
  const persistComboStrategies = pageHandler("persistComboStrategies", {
    fetch: async (url, options) => {
      writes.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true };
    },
    setComboStrategies: (updated) => states.push(updated),
  });
  return { writes, states, persistComboStrategies };
}

const initialStrategies = () => ({
  selected: {
    fallbackStrategy: "fusion",
    judgeModel: "openai/judge",
    fusionTuning: { minPanel: 1, stragglerGraceMs: 5000 },
    smartInstructions: "Preserve these instructions when switching strategies.",
    routerModel: "openai/router",
  },
  untouched: { fallbackStrategy: "smart", smartInstructions: "Keep this combo." },
});

const unexpectedAlert = (message) => assert.fail(message);

test("RouteWeave is available in the shared single and bulk strategy selector", () => {
  const options = page.match(/const STRATEGY_OPTIONS = (\[[\s\S]*?\n\]);/);
  assert.ok(options);
  const values = new Function(`return ${options[1]}`)();
  assert.equal(values.filter(({ value }) => value === "routeweave").length, 1);
  assert.match(values.find(({ value }) => value === "routeweave").label, /RouteWeave/);
  assert.equal((page.match(/options=\{STRATEGY_OPTIONS\}/g) || []).length, 2);
  assert.match(page, /onSetStrategy\(\{ fallbackStrategy: e\.target\.value \}\)/);
  assert.match(page, /if \(v\) handleBulkSetStrategy\(v\)/);
  assert.match(page, /current === "routeweave"/);
  assert.match(page, /private backend configured in server environment variables/);
  assert.match(page, /flat canonical OpenAI\/Anthropic targets/);
  assert.match(page, /default active_required/);
  assert.match(page, /Shadow uses admitted original order, not Smart Router/);
});

test("selecting RouteWeave persists the entire map and preserves unrelated combo fields", async () => {
  const comboStrategies = initialStrategies();
  const before = structuredClone(comboStrategies);
  const writer = strategyWriter();
  const setStrategy = pageHandler("handleSetComboStrategy", {
    comboStrategies,
    persistComboStrategies: writer.persistComboStrategies,
    alert: unexpectedAlert,
  });
  await setStrategy("selected", { fallbackStrategy: "routeweave" });
  const expected = { ...before, selected: { ...before.selected, fallbackStrategy: "routeweave" } };
  assert.deepEqual(writer.writes, [{ url: "/api/settings", method: "PATCH", body: { comboStrategies: expected } }]);
  assert.deepEqual(writer.states, [expected]);
  assert.deepEqual(comboStrategies, before);
});

test("bulk RouteWeave selection preserves other combos and existing Smart/Fusion settings", async () => {
  const comboStrategies = initialStrategies();
  const before = structuredClone(comboStrategies);
  const writer = strategyWriter();
  const busy = [];
  const setStrategy = pageHandler("handleBulkSetStrategy", {
    comboStrategies,
    selectedCombos: [{ name: "selected" }, { name: "new-combo" }],
    persistComboStrategies: writer.persistComboStrategies,
    setBulkBusy: (value) => busy.push(value),
    alert: unexpectedAlert,
  });
  await setStrategy("routeweave");
  assert.deepEqual(writer.writes[0].body, { comboStrategies: {
    ...before,
    selected: { ...before.selected, fallbackStrategy: "routeweave" },
    "new-combo": { fallbackStrategy: "routeweave" },
  } });
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(comboStrategies, before);
});

function settingsPatch() {
  const writes = [];
  let resets = 0;
  const bindings = {
    NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) },
    PROTECTED_SETTING_KEYS: ["password", "mitmSudoEncrypted"],
    SETTINGS_RESPONSE_HEADERS: { "Cache-Control": "no-store" },
    updateSettings: async (body) => { writes.push(structuredClone(body)); return body; },
    resetComboRotation: () => { resets++; },
  };
  const start = settingsRoute.indexOf("export async function PATCH(request)");
  assert.notEqual(start, -1);
  const PATCH = new Function(...Object.keys(bindings), `return ${settingsRoute.slice(start).replace(/^export /, "")}`)(...Object.values(bindings));
  return { PATCH, writes, resets: () => resets };
}

for (const fallbackStrategy of ["routeweave", "smart"]) {
  test(`settings PATCH persists ${fallbackStrategy} without checking backend configuration`, async () => {
    const route = settingsPatch();
    const comboStrategies = initialStrategies();
    // Existing unrelated strategy fields survive switching strategies.
    comboStrategies.selected.fallbackStrategy = fallbackStrategy;
    const response = await route.PATCH({ json: async () => ({ comboStrategies }) });
    assert.equal(response.status, 200);
    assert.deepEqual(route.writes, [{ comboStrategies }]);
    assert.deepEqual(response.body.comboStrategies, comboStrategies);
    assert.equal(route.resets(), 1);
    assert.doesNotMatch(settingsRoute, /ROUTEWEAVE_|readRouteweaveConfig/);
  });
}
