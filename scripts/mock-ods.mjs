// Offline mock of the data.gov.bh OpenDataSoft Explore API v2.1 (just the two
// endpoints the sync engine uses) plus control endpoints to simulate the
// portal publishing new data:
//   GET  /api/explore/v2.1/catalog/datasets?limit&offset&order_by=dataset_id
//   GET  /api/explore/v2.1/catalog/datasets/:id/exports/json
//   POST /__mock/bump?id=<dataset_id>   append a new period row + bump `modified`
//   POST /__mock/add?id=<new_id>        add a brand-new dataset
//   POST /__mock/remove?id=<dataset_id> delete a dataset upstream
//   GET  /__mock/state                  current ids + modified + hit counters
import http from "node:http";

const PORT = Number(process.env.MOCK_ODS_PORT || 4010);
const now = () => new Date().toISOString();

const hits = { catalog: 0, export: 0 };

function mkYearly(base, years, series) {
  const rows = [];
  for (let y = years[0]; y <= years[1]; y++) {
    for (const s of series) {
      rows.push({ year: String(y), indicator: s.name, value: Math.round(base * s.k * (1 + (y - years[0]) * 0.03)) });
    }
  }
  return rows;
}

const datasets = new Map();
function put(id, meta, fields, rows) {
  datasets.set(id, {
    dataset_id: id,
    fields,
    metas: { default: { ...meta, records_count: rows.length, modified: "2026-01-15T08:00:00+00:00" } },
    rows,
  });
}

const F = {
  year: { name: "year", label: "Year", type: "text" },
  indicator: { name: "indicator", label: "Indicator", type: "text" },
  value: { name: "value", label: "Value", type: "int" },
};

put("population-by-nationality", { title: "Population by Nationality 2010-2025", description: "Mid-year population estimates for Bahrainis and non-Bahrainis.", theme: ["Population"], publisher: "Information & eGovernment Authority" }, [F.year, { name: "nationality", label: "Nationality", type: "text" }, F.value],
  mkYearly(700000, [2010, 2025], [{ name: "Bahraini", k: 1 }, { name: "Non-Bahraini", k: 1.2 }]).map((r) => ({ year: r.year, nationality: r.indicator, value: r.value })));
put("live-births-by-governorate", { title: "Live Births by Governorate", description: "Annual registered live births.", theme: ["Health"], publisher: "Ministry of Health" }, [F.year, { name: "governorate", label: "Governorate", type: "text" }, F.value],
  mkYearly(5000, [2015, 2025], [{ name: "Capital", k: 1 }, { name: "Muharraq", k: 0.6 }, { name: "Northern", k: 0.9 }, { name: "Southern", k: 0.5 }]).map((r) => ({ year: r.year, governorate: r.indicator, value: r.value })));
put("unemployment-rate", { title: "Unemployment Rate", description: "Quarterly unemployment rate.", theme: ["Labour"], publisher: "Labour Market Regulatory Authority" }, [{ name: "date", label: "Date", type: "date" }, { name: "rate", label: "Rate", type: "double" }],
  Array.from({ length: 24 }, (_, i) => ({ date: `${2020 + Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, "0")}-01`, rate: 3.5 + ((i * 7) % 5) / 10 })));
put("seaports", { title: "Seaports Cargo Throughput", description: "Containers handled per year.", theme: ["Transport"], publisher: "Ministry of Transportation" }, [F.year, F.value],
  Array.from({ length: 12 }, (_, i) => ({ year: String(2014 + i), value: 1000000 + i * 52000 })));
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

function catalogEntry(d) {
  return { dataset_id: d.dataset_id, fields: d.fields, metas: d.metas };
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (p === "/api/explore/v2.1/catalog/datasets") {
      hits.catalog++;
      const limit = Number(url.searchParams.get("limit") || 10);
      const offset = Number(url.searchParams.get("offset") || 0);
      const all = [...datasets.values()].sort((a, b) => a.dataset_id.localeCompare(b.dataset_id));
      return json(res, 200, { total_count: all.length, results: all.slice(offset, offset + limit).map(catalogEntry) });
    }
    const single = p.match(/^\/api\/explore\/v2\.1\/catalog\/datasets\/([^/]+)$/);
    if (single) {
      hits.catalog++;
      const d = datasets.get(decodeURIComponent(single[1]));
      return d ? json(res, 200, catalogEntry(d)) : json(res, 404, { error: "not found" });
    }
    const m = p.match(/^\/api\/explore\/v2\.1\/catalog\/datasets\/([^/]+)\/exports\/json$/);
    if (m) {
      hits.export++;
      const d = datasets.get(decodeURIComponent(m[1]));
      if (!d) return json(res, 404, { error: "not found" });
      return json(res, 200, d.rows);
    }
    if (p === "/__mock/state") {
      return json(res, 200, { hits, datasets: [...datasets.values()].map((d) => ({ id: d.dataset_id, modified: d.metas.default.modified, rows: d.rows.length })) });
    }
    if (p === "/__mock/bump" && req.method === "POST") {
      const d = datasets.get(url.searchParams.get("id") || "");
      if (!d) return json(res, 404, { error: "unknown id" });
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
      return json(res, 200, { ok: true, rows: d.rows.length, modified: d.metas.default.modified });
    }
    if (p === "/__mock/add" && req.method === "POST") {
      const id = url.searchParams.get("id") || `new-dataset-${datasets.size}`;
      put(id, { title: `New Dataset ${id}`, description: "Freshly published upstream.", theme: ["Economy"], publisher: "Ministry of Finance" }, [F.year, F.value],
        Array.from({ length: 6 }, (_, i) => ({ year: String(2020 + i), value: 10 + i })));
      datasets.get(id).metas.default.modified = now();
      return json(res, 200, { ok: true, id });
    }
    if (p === "/__mock/remove" && req.method === "POST") {
      return json(res, 200, { ok: datasets.delete(url.searchParams.get("id") || "") });
    }
    json(res, 404, { error: "not found", path: p });
  })
  .listen(PORT, () => console.log(`mock ODS listening on :${PORT}`));
