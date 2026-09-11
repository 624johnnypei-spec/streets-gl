'use strict';
// PLATEAU (Tokyo) building-attribute lookup. Zero dependencies (Node >= 18).
// Data: data/plateau_buildings.json.gz, built by data/build_plateau_lookup.py.
//   const {lookupBuilding} = require('./plateau.js');
//   lookupBuilding(35.6812, 139.7671) -> {name?, usage?, usage_ja?, height_m?, storeys?, year?, address?, source} | null
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_FILES = [
	path.join(__dirname, 'data', 'plateau_buildings.json.gz'),
	path.join(__dirname, 'data', 'plateau_buildings.json')
];
const NEAREST_M = 25; // fallback radius when no footprint contains the point
const CELL = 0.001; // grid cell size in degrees (~110 m x 90 m)
const E6 = 1e6;
const M_PER_DEG_LAT = 111320;

let db = null; // lazily built index
let loadFailed = false;

function load() {
	const file = DATA_FILES.find(f => fs.existsSync(f));
	if (!file) throw new Error('plateau: data file not found (' + DATA_FILES.join(' | ') + ')');
	let buf = fs.readFileSync(file);
	if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
	const doc = JSON.parse(buf.toString('utf8'));
	buf = null;
	const recs = doc.b, n = recs.length;

	// Flatten records into typed arrays (keeps retained heap small).
	const cLat = new Float64Array(n), cLon = new Float64Array(n);
	const height = new Float32Array(n).fill(NaN);
	const storeys = new Int16Array(n), year = new Int16Array(n), usage = new Int16Array(n);
	const addr = new Int32Array(n).fill(-1);
	const names = new Map();
	const bbox = new Int32Array(n * 4); // minLat, minLon, maxLat, maxLon (1e-6 deg)
	const recRing = new Int32Array(n + 1); // record -> first ring index
	let ringCount = 0, vertCount = 0;
	for (const r of recs) for (const ring of r.f) { ringCount++; vertCount += ring.length >> 1; }
	const ringOff = new Int32Array(ringCount + 1); // ring -> first vertex index
	const verts = new Int32Array(vertCount * 2); // lat,lon pairs (1e-6 deg, absolute)

	let ri = 0, vi = 0;
	for (let i = 0; i < n; i++) {
		const r = recs[i];
		cLat[i] = r.c[0]; cLon[i] = r.c[1];
		if (r.h !== undefined) height[i] = r.h;
		if (r.s !== undefined) storeys[i] = r.s;
		if (r.y !== undefined) year[i] = r.y;
		if (r.u !== undefined) usage[i] = r.u;
		if (r.a !== undefined) addr[i] = r.a;
		if (r.n !== undefined) names.set(i, r.n);
		recRing[i] = ri;
		let minLa = Infinity, minLo = Infinity, maxLa = -Infinity, maxLo = -Infinity;
		for (const ring of r.f) {
			ringOff[ri++] = vi;
			let la = Math.round(r.c[0] * E6), lo = Math.round(r.c[1] * E6);
			for (let k = 0; k < ring.length; k += 2) {
				la += ring[k]; lo += ring[k + 1];
				verts[vi * 2] = la; verts[vi * 2 + 1] = lo; vi++;
				if (la < minLa) minLa = la; if (la > maxLa) maxLa = la;
				if (lo < minLo) minLo = lo; if (lo > maxLo) maxLo = lo;
			}
		}
		bbox[i * 4] = minLa; bbox[i * 4 + 1] = minLo; bbox[i * 4 + 2] = maxLa; bbox[i * 4 + 3] = maxLo;
	}
	recRing[n] = ri; ringOff[ringCount] = vi;

	// Grid index: each building goes into every cell its (bbox + NEAREST_M) touches.
	const [bMinLat, bMinLon, bMaxLat, bMaxLon] = doc.bbox;
	const padLat = NEAREST_M / M_PER_DEG_LAT + 0.001, padLon = NEAREST_M / (M_PER_DEG_LAT * Math.cos(bMinLat * Math.PI / 180)) + 0.001;
	const lat0 = bMinLat - padLat, lon0 = bMinLon - padLon;
	const rows = Math.ceil((bMaxLat + padLat - lat0) / CELL) + 1, cols = Math.ceil((bMaxLon + padLon - lon0) / CELL) + 1;
	const kx = M_PER_DEG_LAT * Math.cos(((bMinLat + bMaxLat) / 2) * Math.PI / 180);
	const eLat = NEAREST_M / M_PER_DEG_LAT * E6, eLon = NEAREST_M / kx * E6;
	const clampR = r => Math.max(0, Math.min(rows - 1, r)), clampC = c => Math.max(0, Math.min(cols - 1, c));
	const cellRange = i => [
		clampR(Math.floor(((bbox[i * 4] - eLat) / E6 - lat0) / CELL)), clampC(Math.floor(((bbox[i * 4 + 1] - eLon) / E6 - lon0) / CELL)),
		clampR(Math.floor(((bbox[i * 4 + 2] + eLat) / E6 - lat0) / CELL)), clampC(Math.floor(((bbox[i * 4 + 3] + eLon) / E6 - lon0) / CELL))
	];
	const cellStart = new Int32Array(rows * cols + 1);
	for (let i = 0; i < n; i++) {
		const [r0, c0, r1, c1] = cellRange(i);
		for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellStart[r * cols + c + 1]++;
	}
	for (let k = 0; k < rows * cols; k++) cellStart[k + 1] += cellStart[k];
	const fill = cellStart.slice(0, rows * cols);
	const cellItems = new Int32Array(cellStart[rows * cols]);
	for (let i = 0; i < n; i++) {
		const [r0, c0, r1, c1] = cellRange(i);
		for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellItems[fill[r * cols + c]++] = i;
	}

	const usageLabels = {};
	for (const [code, [en, ja]] of Object.entries(doc.usage)) usageLabels[code] = {en, ja};
	return {n, cLat, cLon, height, storeys, year, usage, addr, names, bbox, recRing, ringOff, verts,
		addrTable: doc.addr, usageLabels, lat0, lon0, rows, cols, kx, cellStart, cellItems};
}

function getDb() {
	if (db || loadFailed) return db;
	try {
		const t = Date.now();
		db = load();
		console.log(`[plateau] loaded ${db.n} buildings in ${Date.now() - t} ms`);
	} catch (e) {
		loadFailed = true;
		console.warn('[plateau] disabled:', e.message);
	}
	return db;
}

// Even-odd point-in-ring test plus squared distance (m^2) to the ring boundary.
function ringTest(d, ring, pLat, pLon) {
	const s = d.ringOff[ring], e = d.ringOff[ring + 1], v = d.verts, kx = d.kx;
	let inside = false, best = Infinity;
	for (let a = s, b = e - 1; a < e; b = a++) {
		const ay = v[a * 2], ax = v[a * 2 + 1], by = v[b * 2], bx = v[b * 2 + 1];
		if ((ay > pLat) !== (by > pLat) && pLon < (bx - ax) * (pLat - ay) / (by - ay) + ax) inside = !inside;
		// segment distance in local metres
		const x1 = (ax - pLon) / E6 * kx, y1 = (ay - pLat) / E6 * M_PER_DEG_LAT;
		const x2 = (bx - pLon) / E6 * kx, y2 = (by - pLat) / E6 * M_PER_DEG_LAT;
		const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
		const t = len2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
		const qx = x1 + t * dx, qy = y1 + t * dy, d2 = qx * qx + qy * qy;
		if (d2 < best) best = d2;
	}
	return {inside, d2: best};
}

function toResult(d, i, distance) {
	const out = {};
	const name = d.names.get(i);
	if (name) out.name = name;
	const u = d.usage[i] && d.usageLabels[d.usage[i]];
	if (u) { out.usage = u.en; out.usage_ja = u.ja; }
	if (!Number.isNaN(d.height[i])) out.height_m = Math.round(d.height[i] * 10) / 10;
	if (d.storeys[i] > 0) out.storeys = d.storeys[i];
	if (d.year[i] > 0) out.year = d.year[i];
	if (d.addr[i] >= 0) out.address = d.addrTable[d.addr[i]];
	if (distance > 0) out.distance_m = Math.round(distance * 10) / 10;
	out.source = 'PLATEAU (Tokyo)';
	return out;
}

/**
 * Building whose footprint contains (lat, lon); else the building whose footprint edge
 * is nearest within 25 m; else null (also null outside the covered wards).
 */
function lookupBuilding(lat, lon) {
	lat = Number(lat); lon = Number(lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const d = getDb();
	if (!d) return null;
	const r = Math.floor((lat - d.lat0) / CELL), c = Math.floor((lon - d.lon0) / CELL);
	if (r < 0 || c < 0 || r >= d.rows || c >= d.cols) return null;
	const pLat = lat * E6, pLon = lon * E6;
	let hit = -1, hitArea = Infinity, near = -1, nearD2 = NEAREST_M * NEAREST_M;
	for (let k = d.cellStart[r * d.cols + c], end = d.cellStart[r * d.cols + c + 1]; k < end; k++) {
		const i = d.cellItems[k], b = i * 4;
		const inBox = pLat >= d.bbox[b] && pLat <= d.bbox[b + 2] && pLon >= d.bbox[b + 1] && pLon <= d.bbox[b + 3];
		for (let ring = d.recRing[i]; ring < d.recRing[i + 1]; ring++) {
			const t = ringTest(d, ring, pLat, pLon);
			if (inBox && t.inside) {
				// overlapping footprints (e.g. podium + tower): prefer the smallest
				const area = (d.bbox[b + 2] - d.bbox[b]) * (d.bbox[b + 3] - d.bbox[b + 1]);
				if (area < hitArea) { hit = i; hitArea = area; }
			} else if (t.d2 < nearD2) { near = i; nearD2 = t.d2; }
		}
	}
	if (hit >= 0) return toResult(d, hit, 0);
	if (near >= 0) return toResult(d, near, Math.sqrt(nearD2));
	return null;
}

module.exports = {lookupBuilding, _load: getDb};
