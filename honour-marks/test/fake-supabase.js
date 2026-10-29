"use strict";
/**
 * Fake Supabase client for integration-testing the ledger and quest flows
 * without a network. Implements only the query shapes this codebase uses.
 */

function matchFilters(row, filters) {
  return filters.every(([col, op, val]) => {
    const cell = row[col];
    if (op === "eq") return String(cell) === String(val);
    if (op === "is") return val === null ? cell == null : cell === val;
    if (op === "lte") return String(cell) <= String(val);
    if (op === "gt") return Number(cell) > Number(val);
    if (op === "ilike") return String(cell || "").toLowerCase() === String(val || "").toLowerCase();
    if (op === "contains") return Array.isArray(cell) && val.every((v) => cell.includes(v));
    return true;
  });
}

function createFakeSupabase(tables = {}) {
  const db = {};
  for (const [name, rows] of Object.entries(tables)) db[name] = rows.map((r) => ({ ...r }));
  let nextId = 1000;
  const calls = [];

  function table(name) {
    if (!db[name]) db[name] = [];
    return db[name];
  }

  function builder(name) {
    const q = { filters: [], payload: null, op: "select", cols: null, limit: null, order: [] };

    const api = {
      select(cols) { q.cols = cols; if (!q.payload) q.op = "select"; return api; },
      insert(payload) { q.op = "insert"; q.payload = payload; return api; },
      update(payload) { q.op = "update"; q.payload = payload; return api; },
      delete() { q.op = "delete"; return api; },
      upsert(payload) { q.op = "upsert"; q.payload = payload; return api; },
      eq(col, val) { q.filters.push([col, "eq", val]); return api; },
      is(col, val) { q.filters.push([col, "is", val]); return api; },
      lte(col, val) { q.filters.push([col, "lte", val]); return api; },
      gt(col, val) { q.filters.push([col, "gt", val]); return api; },
      ilike(col, val) { q.filters.push([col, "ilike", val]); return api; },
      contains(col, val) { q.filters.push([col, "contains", val]); return api; },
      order(col, opts = {}) { q.order.push([col, opts.ascending !== false]); return api; },
      limit(n) { q.limit = n; return api; },
      maybeSingle() { q.single = true; return api; },
      then(resolve) {
        calls.push({ table: name, op: q.op, filters: q.filters });
        let rows = table(name);

        if (q.op === "insert" || q.op === "upsert") {
          const payloads = Array.isArray(q.payload) ? q.payload : [q.payload];
          const out = [];
          for (const p of payloads) {
            const row = { id: nextId++, ...p };
            if (q.op === "upsert") {
              // onConflict is ignored; simulate a primary-key merge on user_id
              const key = Object.keys(p).includes("page_index")
                ? { guild_id: p.guild_id, panel_key: p.panel_key, page_index: p.page_index }
                : { user_id: p.user_id };
              const existing = rows.find((r) =>
                Object.entries(key).every(([k, v]) => String(r[k]) === String(v))
              );
              if (existing) { Object.assign(existing, p); out.push(existing); continue; }
            }
            rows.push(row);
            out.push(row);
          }
          return resolve({ data: out, error: null });
        }

        rows = rows.filter((r) => matchFilters(r, q.filters));

        if (q.op === "update") {
          for (const r of rows) Object.assign(r, q.payload);
          return resolve({ data: q.cols ? rows : null, error: null });
        }
        if (q.op === "delete") {
          const removed = rows.slice();
          for (const r of removed) {
            const idx = table(name).indexOf(r);
            if (idx !== -1) table(name).splice(idx, 1);
          }
          return resolve({ data: q.cols ? removed : null, error: null });
        }

        for (const [col, asc] of q.order.reverse()) {
          rows.sort((a, b) => {
            const av = a[col], bv = b[col];
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        if (q.limit) rows = rows.slice(0, q.limit);

        if (q.single) return resolve({ data: rows[0] || null, error: null });
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      },
    };
    return api;
  }

  return {
    db,
    calls,
    from: (name) => builder(name),
    reset() { for (const k of Object.keys(db)) db[k] = []; },
  };
}

module.exports = { createFakeSupabase };
