import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ adapter: null }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => state.adapter }));
import { createCombo, updateCombo, getComboByName, deleteCombo } from "../../src/lib/db/repos/combosRepo.js";

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE combos(id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT); CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT);");
  state.adapter = {
    run: (sql, args = []) => db.prepare(sql).run(...args),
    get: (sql, args = []) => db.prepare(sql).get(...args),
    all: (sql, args = []) => db.prepare(sql).all(...args),
    transaction: fn => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } },
  };
});

describe("combo routing persistence", () => {
  it("round-trips explicit unrestricted and blocked exceptions through edits and rename", async () => {
    const policy = { zdr: true, quantizations: [], allowImageWithoutZdr: false };
    const combo = await createCombo({ name: "quality", models: ["openrouter/vendor/model"], openrouterRouting: policy });
    expect((await getComboByName("quality")).openrouterRouting).toEqual(policy);
    await updateCombo(combo.id, { name: "budget", models: ["openrouter/vendor/other"] });
    expect((await getComboByName("budget")).openrouterRouting).toEqual(policy);
    await updateCombo(combo.id, { openrouterRouting: null });
    expect((await getComboByName("budget")).openrouterRouting).toBeNull();
  });

  it("survives strategy resets and deletes only the removed combo's policy", async () => {
    const first = await createCombo({ name: "first", openrouterRouting: { quantizations: ["bf16"] } });
    const second = await createCombo({ name: "second", openrouterRouting: { zdr: true } });
    const db = state.adapter;
    const settings = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    settings.comboStrategies = {};
    db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(settings)]);
    expect((await getComboByName("first")).openrouterRouting).toEqual({ quantizations: ["bf16"] });
    await deleteCombo(first.id);
    const saved = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    expect(saved.comboOpenrouterRouting[first.id]).toBeUndefined();
    expect(saved.comboOpenrouterRouting[second.id]).toEqual({ zdr: true });
  });

  it("rejects invalid changes without touching the existing combo", async () => {
    const combo = await createCombo({ name: "safe", openrouterRouting: { zdr: true } });
    await expect(updateCombo(combo.id, { name: "changed", openrouterRouting: { zdr: false } })).rejects.toThrow();
    expect((await getComboByName("safe")).openrouterRouting).toEqual({ zdr: true });
  });
});
