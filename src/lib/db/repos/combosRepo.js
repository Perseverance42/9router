import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { normalizeOpenRouterComboRouting } from "open-sse/services/openrouterRouting.js";

function readComboSettings(db) {
  return parseJson(db.get(`SELECT data FROM settings WHERE id = 1`)?.data, {});
}

function writeComboSettings(db, settings) {
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(settings)]);
}

function rowToCombo(row, settings) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    openrouterRouting: settings?.comboOpenrouterRouting?.[row.id] ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  const settings = readComboSettings(db);
  return rows.map(row => rowToCombo(row, settings));
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row, readComboSettings(db));
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row, readComboSettings(db));
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    openrouterRouting: normalizeOpenRouterComboRouting(data.openrouterRouting ?? null),
    createdAt: now,
    updatedAt: now,
  };
  db.transaction(() => {
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
    );
    if (combo.openrouterRouting) {
      const settings = readComboSettings(db);
      settings.comboOpenrouterRouting ||= {};
      settings.comboOpenrouterRouting[combo.id] = combo.openrouterRouting;
      writeComboSettings(db, settings);
    }
  });
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  const routing = Object.hasOwn(data, "openrouterRouting")
    ? normalizeOpenRouterComboRouting(data.openrouterRouting) : undefined;
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const settings = readComboSettings(db);
    const merged = { ...rowToCombo(row, settings), ...data, updatedAt: new Date().toISOString() };
    if (routing !== undefined) merged.openrouterRouting = routing;
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    if (routing !== undefined) {
      settings.comboOpenrouterRouting ||= {};
      if (routing) settings.comboOpenrouterRouting[id] = routing;
      else delete settings.comboOpenrouterRouting[id];
    }
    if (row.name !== merged.name) {
      settings.comboStrategies ||= {};
      const strategy = { ...settings.comboStrategies[row.name] };
      delete settings.comboStrategies[row.name];
      if (Object.keys(strategy).length) settings.comboStrategies[merged.name] = strategy;
    }
    if (row.name !== merged.name || routing !== undefined) writeComboSettings(db, settings);
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const row = db.get(`SELECT name FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
    const settings = readComboSettings(db);
    if (settings.comboStrategies) delete settings.comboStrategies[row.name];
    if (settings.comboOpenrouterRouting) delete settings.comboOpenrouterRouting[id];
    writeComboSettings(db, settings);
  });
  return deleted;
}
