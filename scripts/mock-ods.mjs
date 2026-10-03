// Offline mock of the data.gov.bh OpenDataSoft Explore API v2.1 (just the
// endpoints the sync engine uses) plus control endpoints to simulate the
// portal publishing, withdrawing and breaking data.
//
// Run it:      MOCK_ODS_PORT=4010 node scripts/mock-ods.mjs       (or `pnpm mock:ods`)
// Use it:      ODS_BASE_URL=http://127.0.0.1:4010/api/explore/v2.1 pnpm sync
// In a test:   const mock = await startMockOds({ port: 0 });  // random free port
//              process.env.ODS_BASE_URL = `${mock.url}/api/explore/v2.1`;
//              ...; await mock.close();
//
// Portal endpoints
//   GET  /api/explore/v2.1/catalog/datasets?limit&offset&order_by=dataset_id   (limit > 100 -> 400, like ODS)
//   GET  /api/explore/v2.1/catalog/datasets/:id
//   GET  /api/explore/v2.1/catalog/datasets/:id/exports/json
//
// Control endpoints (all state is per mock instance)
//   GET  /__mock/state                 ids, modified, row counts, active modes, request counters
//   POST /__mock/reset                 restore the fixtures, clear every mode and counter
//   POST /__mock/mutate?id=<id>&mode=<mode>[&ms=&times=&fraction=]   per-dataset modes:
//          bump         append a period of rows; advance modified, data_processed and records_count
//          bump-meta    advance modified + metadata_processed only (rows unchanged)
//          set-modified set `modified` to the raw string in &value= (e.g. a far-future date)
//          set-title    set the title to &value= (a metadata-only change: the version token is unchanged)
//          empty        export answers [] while the catalog still claims the old records_count
//          truncate     export answers only `fraction` (default 0.3) of the rows, catalog count unchanged
//          slow         export sends headers + "[" then stalls `ms` (default 3000) before the rest
//          http500      export answers 500 for the next `times` requests (default: always)
//          http429      export answers 429 + Retry-After: 1 for the next `times` requests (default: always)
//          schema-break catalog entry gets records_count "n/a" (the sync must skip + report it)
//          remove       drop the dataset from the catalog (upstream removal)
//          restore      clear this dataset's modes
//   POST /__mock/mutate?mode=<mode>    catalog-wide modes:
//          catalog-short  pages silently omit the last `n` (default 3) entries; total_count stays
//          catalog-empty  total_count 0 and no results
//          catalog-500    catalog list answers 500
//          single-404     GET .../catalog/datasets/:id answers 404 (portal without that endpoint)
//          heal           clear the catalog-wide modes
//   Legacy: POST /__mock/bump?id=, /__mock/add?id=, /__mock/remove?id=
//   POST /__mock/add?id=<new_id>       add a brand-new dataset
//   POST /__mock/add-big?id=&rows=&claim=   add a large dataset (default 120000 rows); `claim`
//                                      overrides the catalog records_count (test maxRecords
//                                      deferral without paying for the rows)
import http from "node:http";
import { pathToFileURL } from "node:url";

const now = () => new Date().toISOString();

function mkYearly(base, years, series) {
  const rows = [];
  for (let y = years[0]; y <= years[1]; y++) {
    for (const s of series) {
      rows.push({ year: String(y), indicator: s.name, value: Math.round(base * s.k * (1 + (y - years[0]) * 0.03)) });
    }
  }
  return rows;
}

const F = {
  year: { name: "year", label: "Year", type: "text" },
  value: { name: "value", label: "Value", type: "int" },
};

const BASE_PORTAL_TIME = "2026-01-15T08:00:00+00:00";

/** Build the default fixtures into `datasets`. Some carry the extra portal metas
 *  (title_ar / keyword / license / language / data_processed / metadata_processed),
 *  some deliberately do not, so both code paths stay exercised. */
function seedFixtures(datasets) {
  function put(id, meta, fields, rows, extras = {}) {
    datasets.set(id, {
      dataset_id: id,
      fields,
      metas: {
        default: {
          ...meta,
          records_count: rows.length,
          modified: BASE_PORTAL_TIME,
          ...extras,
        },
      },
      rows,
      mode: {},
    });
  }

  put("population-by-nationality", { title: "Population by Nationality 2010-2025", description: "Mid-year population estimates for Bahrainis and non-Bahrainis.", theme: ["Population"], publisher: "Information & eGovernment Authority" }, [F.year, { name: "nationality", label: "Nationality", type: "text" }, F.value],
    mkYearly(700000, [2010, 2025], [{ name: "Bahraini", k: 1 }, { name: "Non-Bahraini", k: 1.2 }]).map((r) => ({ year: r.year, nationality: r.indicator, value: r.value })),
    { title_ar: "السكان حسب الجنسية 2010-2025", keyword: ["population", "nationality", "census", "السكان"], license: "Open Data License", language: "en", data_processed: "2026-01-15T08:05:00+00:00", metadata_processed: "2026-01-10T09:00:00+00:00" });
  put("live-births-by-governorate", { title: "Live Births by Governorate", description: "Annual registered live births.", theme: ["Health"], publisher: "Ministry of Health" }, [F.year, { name: "governorate", label: "Governorate", type: "text" }, F.value],
    mkYearly(5000, [2015, 2025], [{ name: "Capital", k: 1 }, { name: "Muharraq", k: 0.6 }, { name: "Northern", k: 0.9 }, { name: "Southern", k: 0.5 }]).map((r) => ({ year: r.year, governorate: r.indicator, value: r.value })),
    { title_ar: "المواليد الأحياء حسب المحافظة", keyword: ["births", "health", "المواليد"], license: "Open Data License", data_processed: "2026-01-15T08:06:00+00:00", metadata_processed: "2026-01-10T09:00:00+00:00" });
  put("unemployment-rate", { title: "Unemployment Rate", description: "Quarterly unemployment rate.", theme: ["Labour"], publisher: "Labour Market Regulatory Authority" }, [{ name: "date", label: "Date", type: "date" }, { name: "rate", label: "Rate", type: "double" }],
    Array.from({ length: 24 }, (_, i) => ({ date: `${2020 + Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, "0")}-01`, rate: 3.5 + ((i * 7) % 5) / 10 })),
    // keyword as ONE comma separated string: the schema must accept both shapes.
    { keyword: "labour, unemployment, jobs", license: "Open Data License" });
  put("seaports", { title: "Seaports Cargo Throughput", description: "Containers handled per year.", theme: ["Transport"], publisher: "Ministry of Transportation" }, [F.year, F.value],
    Array.from({ length: 12 }, (_, i) => ({ year: String(2014 + i), value: 1000000 + i * 52000 })),
    { data_processed: "2026-01-15T08:07:00+00:00" });
  put("air-quality-stations", { title: "Air Quality Stations", description: "Monitoring stations and locations.", theme: ["Environment"], publisher: "Supreme Council for Environment" }, [{ name: "station", label: "Station", type: "text" }, { name: "geo", label: "Location", type: "geo_point_2d" }],
    Array.from({ length: 8 }, (_, i) => ({ station: `Station ${i + 1}`, geo: { lon: 50.5 + i * 0.01, lat: 26.1 + i * 0.01 } })));
  put("tourist-arrivals", { title: "Tourist Arrivals by Nationality", description: "Visitors per year.", theme: ["Tourism"], publisher: "Bahrain Tourism and Exhibitions Authority" }, [F.year, { name: "country", label: "Country", type: "text" }, F.value],
    mkYearly(900000, [2016, 2025], [{ name: "GCC", k: 1 }, { name: "Asia", k: 0.2 }, { name: "Europe", k: 0.1 }]).map((r) => ({ year: r.year, country: r.indicator, value: r.value })));
  put("schools-by-type", { title: "Schools by Type", description: "Number of schools by governorate and type.", theme: ["Education"], publisher: "Ministry of Education" }, [{ name: "type", label: "Type", type: "text" }, { name: "governorate", label: "Governorate", type: "text" }, F.value],
    ["Public", "Private"].flatMap((t) => ["Capital", "Muharraq", "Northern", "Southern"].map((g, i) => ({ type: t, governorate: g, value: 20 + i * 7 + (t === "Private" ? 15 : 0) }))));
  put("housing-loans", { title: "Housing Loans", description: "Housing loans issued per year (SAR m).", theme: ["Housing"], publisher: "Ministry of Housing" }, [F.year, F.value],
    Array.from({ length: 10 }, (_, i) => ({ year: String(2016 + i), value: 300 + i * 25 })));
  put("energy-consumption", { title: "Electricity Consumption", description: "GWh per year.", theme: ["Energy"], publisher: "Electricity and Water Authority" }, [F.year, F.value],
    Array.from({ length: 12 }, (_, i) => ({ year: String(2014 + i), value: 14000 + i * 420 })));
  put("empty-dataset", { title: "Empty Dataset", description: "Has no rows (edge case).", theme: ["Other"], publisher: "Test Authority" }, [F.year, F.value], []);
}

function bumpDataset(d) {
  const last = d.rows[d.rows.length - 1];
  if (last && last.year) {
    const ny = String(Number(last.year) + 1);
    const keys = new Set(d.rows.filter((r) => r.year === last.year).map((r) => JSON.stringify({ ...r, value: undefined, year: undefined })));
    for (const k of keys) d.rows.push({ ...JSON.parse(k), year: ny, value: Math.round((last.value || 100) * 1.07) });
  } else {
    d.rows.push({ ...(last || {}), date: "2026-07-01", rate: 3.1 });
  }
  d.metas.default.records_count = d.rows.length;
  d.metas.default.modified = now();
  d.metas.default.data_processed = d.metas.default.modified;
}

function catalogEntry(d) {
  const entry = { dataset_id: d.dataset_id, fields: d.fields, metas: { default: { ...d.metas.default } } };
  if (d.mode.schemaBreak) entry.metas.default.records_count = "n/a";
  return entry;
}

function addBig(datasets, id, rows, claim) {
  const data = Array.from({ length: rows }, (_, i) => ({ year: String(1990 + (i % 35)), category: `C${i % 7}`, value: (i * 37) % 1000 }));
  datasets.set(id, {
    dataset_id: id,
    fields: [F.year, { name: "category", label: "Category", type: "text" }, F.value],
    metas: {
      default: {
        title: `Big Dataset ${id}`,
        description: "Large export used to test row-count limits.",
        theme: ["Economy"],
        publisher: "Ministry of Finance",
        records_count: claim ?? rows,
        modified: now(),
      },
    },
    rows: data,
    mode: {},
  });
}

/**
 * Start a mock portal. `port: 0` picks a free port. Resolves once listening.
 * @param {{ port?: number, host?: string, big?: boolean }} [options]
 * @returns {Promise<{ close: () => Promise<void>, url: string, port: number, state: any }>}
 */
export async function startMockOds({ port = 0, host = "127.0.0.1", big = false } = {}) {
  const datasets = new Map();
  const flags = { catalog: null, catalogShort: 3, single404: false };
  const hits = { catalog: 0, catalogEntry: 0, export: 0, total: 0, exportById: {} };
  // Exports being served right now / the most at once since the last reset (tests that
  // assert big datasets are downloaded one at a time).
  const exportsInFlight = { now: 0, max: 0 };

  const state = {
    datasets,
    flags,
    hits,
    exportsInFlight,
    reset() {
      datasets.clear();
      seedFixtures(datasets);
      if (big) addBig(datasets, "big-dataset", Number(process.env.MOCK_ODS_BIG_ROWS) || 120000);
      flags.catalog = null;
      flags.catalogShort = 3;
      flags.single404 = false;
      hits.catalog = hits.catalogEntry = hits.export = hits.total = 0;
      hits.exportById = {};
      exportsInFlight.now = exportsInFlight.max = 0;
    },
    /** Apply one mutation mode (what POST /__mock/mutate does). Returns a small result object. */
    mutate(id, mode, params = {}) {
      if (!id) {
        if (mode === "catalog-short") { flags.catalog = "short"; flags.catalogShort = Number(params.n) || 3; return { ok: true }; }
        if (mode === "catalog-empty") { flags.catalog = "empty"; return { ok: true }; }
        if (mode === "catalog-500") { flags.catalog = "http500"; return { ok: true }; }
        if (mode === "single-404") { flags.single404 = true; return { ok: true }; }
        if (mode === "heal") { flags.catalog = null; flags.single404 = false; return { ok: true }; }
        return { error: `unknown catalog-wide mode ${mode}`, code: 400 };
      }
      const d = datasets.get(id);
      if (!d) return { error: "unknown id", code: 404 };
      switch (mode) {
        case "bump": bumpDataset(d); return { ok: true, rows: d.rows.length, modified: d.metas.default.modified };
        case "bump-meta":
          d.metas.default.modified = now();
          d.metas.default.metadata_processed = d.metas.default.modified;
          return { ok: true, modified: d.metas.default.modified };
        case "set-modified":
          // A raw `modified` string, e.g. value=9999-12-31T23:59:59Z (a portal serving a bad date).
          d.metas.default.modified = String(params.value ?? "");
          return { ok: true, modified: d.metas.default.modified };
        case "set-title":
          d.metas.default.title = String(params.value ?? "");
          return { ok: true, title: d.metas.default.title };
        case "empty": d.mode.empty = true; return { ok: true };
        case "truncate": d.mode.truncate = Number(params.fraction) || 0.3; return { ok: true };
        case "slow": d.mode.slowMs = Number(params.ms) || 3000; return { ok: true };
        case "http500": d.mode.http500 = params.times ? Number(params.times) : Infinity; return { ok: true };
        case "http429": d.mode.http429 = params.times ? Number(params.times) : Infinity; return { ok: true };
        case "schema-break": d.mode.schemaBreak = true; return { ok: true };
        case "remove": return { ok: datasets.delete(id) };
        case "restore": d.mode = {}; return { ok: true };
        default: return { error: `unknown mode ${mode}`, code: 400 };
      }
    },
  };
  state.reset();

  function json(res, code, body, headers = {}) {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    hits.total++;
    const url = new URL(req.url, "http://mock.local");
    const p = url.pathname;
    const q = url.searchParams;

    if (p === "/api/explore/v2.1/catalog/datasets") {
      hits.catalog++;
      if (flags.catalog === "http500") return json(res, 500, { error: "mock catalog failure" });
      const limit = Number(q.get("limit") ?? 10);
      const offset = Number(q.get("offset") ?? 0);
      if (!Number.isInteger(limit) || limit < 0 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
        return json(res, 400, { error_code: "ODSQLError", message: "limit must be between 0 and 100" });
      }
      if (flags.catalog === "empty") return json(res, 200, { total_count: 0, results: [] });
      const all = [...datasets.values()].sort((a, b) => a.dataset_id.localeCompare(b.dataset_id));
      // "short": the portal reports the true total but pages silently miss the tail
      // (what a dataset removed mid-pagination looks like to the client).
      const visible = flags.catalog === "short" ? all.slice(0, Math.max(0, all.length - flags.catalogShort)) : all;
      return json(res, 200, { total_count: all.length, results: visible.slice(offset, offset + limit).map(catalogEntry) });
    }

    const single = p.match(/^\/api\/explore\/v2\.1\/catalog\/datasets\/([^/]+)$/);
    if (single) {
      hits.catalogEntry++;
      if (flags.single404) return json(res, 404, { error_code: "NotFound", message: "not found" });
      const d = datasets.get(decodeURIComponent(single[1]));
      return d ? json(res, 200, catalogEntry(d)) : json(res, 404, { error: "not found" });
    }

    const exp = p.match(/^\/api\/explore\/v2\.1\/catalog\/datasets\/([^/]+)\/exports\/json$/);
    if (exp) {
      const id = decodeURIComponent(exp[1]);
      hits.export++;
      hits.exportById[id] = (hits.exportById[id] || 0) + 1;
      const d = datasets.get(id);
      if (!d) return json(res, 404, { error: "not found" });
      exportsInFlight.now++;
      exportsInFlight.max = Math.max(exportsInFlight.max, exportsInFlight.now);
      res.once("close", () => {
        exportsInFlight.now--;
      });
      if (d.mode.http429 > 0) {
        d.mode.http429--;
        return json(res, 429, { error: "slow down" }, { "retry-after": "1" });
      }
      if (d.mode.http500 > 0) {
        d.mode.http500--;
        return json(res, 500, { error: "mock export failure" });
      }
      if (d.mode.empty) return json(res, 200, []);
      const rows = d.mode.truncate ? d.rows.slice(0, Math.max(1, Math.floor(d.rows.length * d.mode.truncate))) : d.rows;
      const body = JSON.stringify(rows);
      if (d.mode.slowMs) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(body.slice(0, 1));
        setTimeout(() => res.end(body.slice(1)), d.mode.slowMs);
        return undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }

    if (p === "/__mock/state") {
      return json(res, 200, {
        hits,
        flags,
        datasets: [...datasets.values()].map((d) => ({
          id: d.dataset_id,
          modified: d.metas.default.modified,
          recordsCount: d.metas.default.records_count,
          rows: d.rows.length,
          mode: d.mode,
        })),
      });
    }
    if (p === "/__mock/reset" && req.method === "POST") {
      state.reset();
      return json(res, 200, { ok: true });
    }
    if (p === "/__mock/mutate" && req.method === "POST") {
      const result = state.mutate(q.get("id"), q.get("mode"), Object.fromEntries(q));
      return json(res, result.code ?? 200, result);
    }
    if (p === "/__mock/bump" && req.method === "POST") {
      const result = state.mutate(q.get("id") || "", "bump");
      return json(res, result.code ?? 200, result);
    }
    if (p === "/__mock/add" && req.method === "POST") {
      const id = q.get("id") || `new-dataset-${datasets.size}`;
      datasets.set(id, {
        dataset_id: id,
        fields: [F.year, F.value],
        metas: {
          default: {
            title: `New Dataset ${id}`,
            description: "Freshly published upstream.",
            theme: ["Economy"],
            publisher: "Ministry of Finance",
            records_count: 6,
            modified: now(),
          },
        },
        rows: Array.from({ length: 6 }, (_, i) => ({ year: String(2020 + i), value: 10 + i })),
        mode: {},
      });
      return json(res, 200, { ok: true, id });
    }
    if (p === "/__mock/add-big" && req.method === "POST") {
      const id = q.get("id") || "big-dataset";
      const rows = Number(q.get("rows")) || 120000;
      addBig(datasets, id, rows, q.get("claim") ? Number(q.get("claim")) : undefined);
      return json(res, 200, { ok: true, id, rows });
    }
    if (p === "/__mock/remove" && req.method === "POST") {
      return json(res, 200, { ok: datasets.delete(q.get("id") || "") });
    }
    return json(res, 404, { error: "not found", path: p });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    state,
    close: () =>
      new Promise((resolve) => {
        // Drop keep-alive and stalled ("slow" mode) sockets so close() cannot hang.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// CLI: `node scripts/mock-ods.mjs` (MOCK_ODS_PORT, default 4010; MOCK_ODS_BIG=1 adds a large dataset).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_ODS_PORT || 4010);
  const mock = await startMockOds({ port, big: process.env.MOCK_ODS_BIG === "1" });
  console.log(`mock ODS listening on :${mock.port}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
