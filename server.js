// Serves the built map and two APIs:
//   GET  /api/weather?lat=&lon=   condensed wttr.in forecast (cached 10 min)
//   GET  /api/osm/:type/:id       {type, id, tags, center: {lat, lon}} for a way/relation/node (cached 24 h)
//   POST /api/agent              ai& tool-calling agent that searches places, reads weather,
//                                 and returns camera/time actions for the 3D map to apply.
const http = require('http');
const fs = require('fs');
const path = require('path');
const {lookupBuilding} = require('./plateau.js');

const PORT = process.env.PORT || 8080;
const BUILD_DIR = path.join(__dirname, 'build');
const AI_BASE = process.env.AIAND_BASE_URL || 'https://api.aiand.com/v1';
const AI_KEY = process.env.AIAND_API_KEY;
const AI_MODEL = process.env.AIAND_MODEL || 'deepseek-ai/deepseek-v4-flash';
const UA = 'build-and-ship-streets-gl/1.0 (hackathon demo)';

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
	'.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.txt': 'text/plain'
};

const cache = new Map();
async function cached(key, ttlMs, fn) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.t < ttlMs) return hit.v;
	const v = await fn();
	cache.set(key, {t: Date.now(), v});
	return v;
}

async function getJSON(url, init = {}) {
	const r = await fetch(url, {...init, headers: {'User-Agent': UA, ...(init.headers || {})}});
	if (!r.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${r.status}`);
	return r.json();
}

// ---------- data tools ----------

async function getWeather(lat, lon) {
	const key = `wx:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
	return cached(key, 10 * 60e3, async () => {
		const d = await getJSON(`https://wttr.in/${(+lat).toFixed(4)},${(+lon).toFixed(4)}?format=j1`);
		const c = d.current_condition[0];
		const days = d.weather.map(w => ({
			date: w.date,
			sunrise: w.astronomy[0].sunrise, sunset: w.astronomy[0].sunset, moon_phase: w.astronomy[0].moon_phase,
			minC: +w.mintempC, maxC: +w.maxtempC,
			hourly: w.hourly.map(h => ({
				time: String(h.time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2'),
				tempC: +h.tempC, desc: h.weatherDesc[0].value, code: +h.weatherCode,
				rain: +h.chanceofrain, snow: +h.chanceofsnow, fog: +h.chanceoffog, thunder: +h.chanceofthunder,
				cloud: +h.cloudcover, windKmph: +h.windspeedKmph, precipMM: +h.precipMM, visibilityKm: +h.visibility
			}))
		}));
		return {
			area: d.nearest_area?.[0]?.areaName?.[0]?.value,
			now: {
				tempC: +c.temp_C, feelsC: +c.FeelsLikeC, desc: c.weatherDesc[0].value, code: +c.weatherCode,
				humidity: +c.humidity, cloud: +c.cloudcover, precipMM: +c.precipMM, visibilityKm: +c.visibility,
				windKmph: +c.windspeedKmph, windDir: c.winddir16Point, uv: +c.uvIndex, observed: c.localObsDateTime
			},
			days
		};
	});
}

// Overpass name search around `near` — fallback for when Nominatim rate-limits shared cloud IPs (HTTP 429).
// Matches name / name:en / name:ja / official_name / alt_name case-insensitively within 25 km, ranking
// exact matches first, then stations, then POIs (tourism/amenity/leisure/place), then distance.
const NAME_KEYS = ['name', 'name:en', 'name:ja', 'official_name', 'alt_name'];
const STATION_SUFFIX = /\s*(station|sta\.?|駅)$/i;
// Neutralise regex metacharacters without backslashes (Overpass QL string escaping is fiddly).
const ovpRe = s => s.replace(/[.*+?(){}|$]/g, c => `[${c}]`).replace(/[\^[\]\\"]/g, '.');
const ovpStr = s => s.replace(/[\\"]/g, '\\$&');
const titleCase = s => s.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());

async function overpassPost(data) {
	// Public mirrors are individually flaky (kumi and mail.ru both hung at times while testing), so race them
	// and take the first good answer: worst case is one 15 s timeout instead of 15 s per endpoint.
	const endpoints = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
	const ctrl = endpoints.map(() => new AbortController());
	try {
		return await Promise.any(endpoints.map((endpoint, i) =>
			getJSON(endpoint, {method: 'POST', body: new URLSearchParams({data}), signal: AbortSignal.any([ctrl[i].signal, AbortSignal.timeout(15e3)])})
				.then(r => { ctrl.forEach((c, j) => j !== i && c.abort()); return r; })
				.catch(e => { console.warn('overpass name search failed', endpoint, e.message); throw e; })));
	} catch {
		return null;
	}
}

async function searchOverpassName(query, near) {
	const c = near || {lat: 35.6812, lon: 139.7671}; // default: Tokyo Station
	const q = String(query).trim().replace(/\s+/g, ' ');
	const stripped = STATION_SUFFIX.test(q) ? q.replace(STATION_SUFFIX, '').trim() : '';
	const around = `(around:25000,${c.lat},${c.lon})`;
	// Pass 1 (fast, tag-index lookups): exact names in the common casings. Case-insensitive regex over
	// every name value is too slow on Overpass (~10 s per key), so it's only the fallback pass below.
	const variants = s => [...new Set([s, titleCase(s), titleCase(s.toLowerCase())])];
	const exact = variants(q).flatMap(v => NAME_KEYS.map(k => `nwr["${k}"="${ovpStr(v)}"]${around};`))
		.concat(stripped ? variants(stripped).flatMap(v => NAME_KEYS.map(k => `nwr["railway"="station"]["${k}"="${ovpStr(v)}"]${around};`)) : []);
	let res = await overpassPost(`[out:json][timeout:15];(${exact.join('')});out center 20;`);
	if (res && !res.elements?.length) {
		// Pass 2 (only if pass 1 reached a server but found nothing): case-insensitive word-order regex (e.g. "Shibuya Crossing" ~ "Shibuya Scramble Crossing") on one key.
		const key = /[^\x00-\x7f]/.test(q) ? 'name' : 'name:en';
		res = await overpassPost(`[out:json][timeout:15];nwr["${key}"~"${q.split(' ').map(ovpRe).join('.*')}",i]${around};out center 20;`);
	}
	if (!res?.elements?.length) return [];
	const qn = q.toLowerCase(), sn = stripped.toLowerCase();
	const toRad = x => x * Math.PI / 180;
	const seen = new Set();
	const ranked = res.elements.filter(e => {
		const id = `${e.type}/${e.id}`;
		if (seen.has(id) || (e.lat ?? e.center?.lat) == null) return false;
		seen.add(id);
		return true;
	}).map(e => {
		const t = e.tags || {}, lat = e.lat ?? e.center.lat, lon = e.lon ?? e.center.lon;
		const names = NAME_KEYS.map(k => t[k]).filter(Boolean).flatMap(v => v.split(';')).map(v => v.trim().toLowerCase());
		const station = t.railway === 'station' || t.public_transport === 'station';
		const isExact = names.includes(qn) || (station && sn && names.includes(sn));
		// Landmarks (tourism/leisure/place) edge out amenities so "Tokyo Tower" beats a bike dock named after it.
		const tier = (isExact ? 0 : 4) + (station ? 0 : (t.tourism || t.leisure || t.place || t.historic) ? 1 : t.amenity ? 2 : 3);
		const dist = 6371e3 * 2 * Math.asin(Math.sqrt(Math.sin(toRad(lat - c.lat) / 2) ** 2 + Math.cos(toRad(c.lat)) * Math.cos(toRad(lat)) * Math.sin(toRad(lon - c.lon) / 2) ** 2));
		const kindKey = ['railway', 'public_transport', 'tourism', 'amenity', 'leisure', 'place', 'shop', 'building', 'highway'].find(k => t[k]);
		const name = t['name:en'] || t.name || q;
		const addr = t['addr:full'] || ['addr:province', 'addr:city', 'addr:quarter', 'addr:neighbourhood', 'addr:block_number', 'addr:housenumber'].map(k => t[k]).filter(Boolean).join(' ');
		return {
			tier, dist,
			r: {name, address: [t.name && t.name !== name ? t.name : null, addr || null, 'Tokyo (OpenStreetMap)'].filter(Boolean).join(', '), lat, lon, kind: kindKey ? `${kindKey}/${t[kindKey]}` : `osm/${e.type}`}
		};
	}).sort((a, b) => a.tier - b.tier || a.dist - b.dist);
	// Drop near-duplicates (e.g. one station mapped per operator) so the 5 slots stay useful.
	const out = [];
	for (const {r} of ranked) {
		if (out.some(o => o.name === r.name && Math.abs(o.lat - r.lat) < 0.003 && Math.abs(o.lon - r.lon) < 0.003)) continue;
		out.push(r);
		if (out.length === 5) break;
	}
	return out;
}

async function searchPlace(query, near) {
	const params = new URLSearchParams({q: query, format: 'jsonv2', limit: '5', 'accept-language': 'en,ja'});
	if (near) {
		const d = 0.25;
		params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
	}
	return cached(`geo:${params}`, 60 * 60e3, async () => {
		// Order: Nominatim -> Overpass name search -> Photon.
		// DISABLE_NOMINATIM=1 skips Nominatim (simulates the HTTP 429 seen from shared cloud IPs, for testing).
		try {
			if (process.env.DISABLE_NOMINATIM === '1') throw new Error('disabled via DISABLE_NOMINATIM');
			const res = await getJSON(`https://nominatim.openstreetmap.org/search?${params}`, {signal: AbortSignal.timeout(8e3)});
			if (res.length) {
				return res.map(p => ({name: p.name || p.display_name.split(',')[0], address: p.display_name, lat: +p.lat, lon: +p.lon, kind: `${p.category}/${p.type}`}));
			}
		} catch (e) {
			console.warn('nominatim failed, trying overpass', e.message);
		}
		try {
			const ov = await searchOverpassName(query, near);
			if (ov.length) return ov;
		} catch (e) {
			console.warn('overpass name search failed, using photon', e.message);
		}
		// Last resort: Photon (komoot) — works from cloud IPs but is weak on English names in Japan.
		const pp = new URLSearchParams({q: query, limit: '5'});
		if (near) {
			pp.set('lat', String(near.lat));
			pp.set('lon', String(near.lon));
		}
		const ph = await getJSON(`https://photon.komoot.io/api/?${pp}`);
		return (ph.features || []).map(f => {
			const pr = f.properties || {};
			return {
				name: pr.name || query,
				address: [pr.name, pr.street, pr.district, pr.city, pr.country].filter(Boolean).join(', '),
				lat: f.geometry.coordinates[1],
				lon: f.geometry.coordinates[0],
				kind: `${pr.osm_key}/${pr.osm_value}`
			};
		});
	});
}

const CATEGORY_TAGS = {
	cafe: '["amenity"="cafe"]', restaurant: '["amenity"="restaurant"]', bar: '["amenity"~"bar|pub"]',
	convenience: '["shop"="convenience"]', park: '["leisure"="park"]', station: '["railway"="station"]',
	shrine: '["amenity"="place_of_worship"]["religion"="shinto"]', temple: '["amenity"="place_of_worship"]["religion"="buddhist"]',
	museum: '["tourism"="museum"]', viewpoint: '["tourism"="viewpoint"]', hotel: '["tourism"="hotel"]',
	toilets: '["amenity"="toilets"]', atm: '["amenity"="atm"]', pharmacy: '["amenity"="pharmacy"]', hospital: '["amenity"="hospital"]',
	shelter: '["amenity"="shelter"]', mall: '["shop"="mall"]', library: '["amenity"="library"]'
};

async function findNearby(lat, lon, category, radius = 800) {
	const tag = CATEGORY_TAGS[category] || `["amenity"="${String(category).replace(/[^a-z_]/g, '')}"]`;
	const r = Math.min(Math.max(+radius || 800, 100), 3000);
	const q = `[out:json][timeout:15];nwr${tag}(around:${r},${lat},${lon});out center 40;`;
	return cached(`ovp:${q}`, 30 * 60e3, async () => {
		const res = await getJSON('https://overpass-api.de/api/interpreter', {method: 'POST', body: new URLSearchParams({data: q})});
		const toRad = x => x * Math.PI / 180;
		return res.elements
			.map(e => {
				const plat = e.lat ?? e.center?.lat, plon = e.lon ?? e.center?.lon, t = e.tags || {};
				const dist = 6371e3 * 2 * Math.asin(Math.sqrt(Math.sin(toRad(plat - lat) / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(plat)) * Math.sin(toRad(plon - lon) / 2) ** 2));
				return {
					name: t['name:en'] || t.name || '(unnamed)', name_ja: t.name, lat: plat, lon: plon, distance_m: Math.round(dist),
					hours: t.opening_hours, cuisine: t.cuisine, wheelchair: t.wheelchair, indoor_seating: t.indoor_seating, website: t.website
				};
			})
			.filter(p => p.lat != null)
			.sort((a, b) => a.distance_m - b.distance_m)
			.slice(0, 12);
	});
}

const MANEUVER = {turn: 'Turn', 'new name': 'Continue', depart: 'Head', arrive: 'Arrive', merge: 'Merge', fork: 'Keep', 'end of road': 'Turn', continue: 'Continue', roundabout: 'Enter the roundabout', rotary: 'Enter the roundabout', 'on ramp': 'Take the ramp', 'off ramp': 'Take the exit'};

async function getRoute(from, to, mode) {
	return getRouteVia(from, [to], mode);
}

// One route through several stops in order. stops: [{lat, lon, label?}]; the last is the final destination.
async function getRouteVia(from, stops, mode) {
	const profile = mode === 'bike' ? 'routed-bike' : 'routed-foot';
	const pts = [from, ...stops].map(p => `${(+p.lon).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');
	const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${pts}?overview=full&geometries=geojson&steps=true`;
	const r = await cached(`route:${url}`, 30 * 60e3, async () => {
		const d = await getJSON(url);
		if (d.code !== 'Ok' || !d.routes?.length) throw new Error(`no ${mode} route found`);
		return d.routes[0];
	});
	const steps = r.legs.flatMap((l, legIdx) => l.steps.map(st => {
		const m = st.maneuver;
		if (m.type === 'arrive') {
			const label = stops[legIdx]?.label;
			return {text: label ? `Arrive at ${label}` : 'Arrive at destination', lat: m.location[1], lon: m.location[0], distance_m: Math.round(st.distance)};
		}
		if (m.type === 'depart' && legIdx > 0) {
			return {text: `Continue from ${stops[legIdx - 1]?.label || 'stop'}`, lat: m.location[1], lon: m.location[0], distance_m: Math.round(st.distance)};
		}
		const verb = MANEUVER[m.type] || 'Continue';
		const dir = m.modifier ? ` ${m.modifier}` : '';
		const onto = st.name ? ` onto ${st.name}` : '';
		return {text: `${verb}${dir}${onto}`.replace('Head straight', 'Head'), lat: m.location[1], lon: m.location[0], distance_m: Math.round(st.distance)};
	}));
	return {
		mode: mode === 'bike' ? 'bike' : 'walk',
		distance_m: Math.round(r.distance),
		duration_s: Math.round(r.duration),
		coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
		steps,
		// Where each stop is (the real place, not the snapped road point), for map markers
		waypoints: stops.map((p, i) => ({lat: +p.lat, lon: +p.lon, label: p.label || `Stop ${i + 1}`}))
	};
}

// ---------- OSM feature details (selection panel) ----------

const osmInflight = new Map();

// Tags + centre point for an OSM way/relation/node, cached 24 h. Concurrent requests for the same feature share one upstream call.
function getOSMFeature(type, id) {
	const key = `osm:${type}/${id}`;
	if (osmInflight.has(key)) return osmInflight.get(key);
	const p = cached(key, 24 * 3600e3, async () => {
		const url = type === 'node'
			? `https://api.openstreetmap.org/api/0.6/node/${id}.json`
			: `https://api.openstreetmap.org/api/0.6/${type}/${id}/full.json`;
		const d = await getJSON(url);
		const elements = d.elements || [];
		const self = elements.find(e => e.type === type && e.id === id);
		if (!self) throw new Error(`${type} ${id} not found`);
		let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
		for (const e of elements) {
			if (e.type !== 'node' || e.lat == null) continue;
			minLat = Math.min(minLat, e.lat); maxLat = Math.max(maxLat, e.lat);
			minLon = Math.min(minLon, e.lon); maxLon = Math.max(maxLon, e.lon);
		}
		const center = Number.isFinite(minLat) ? {lat: +((minLat + maxLat) / 2).toFixed(7), lon: +((minLon + maxLon) / 2).toFixed(7)} : null;
		return {type, id, tags: self.tags || {}, center};
	}).finally(() => osmInflight.delete(key));
	osmInflight.set(key, p);
	return p;
}

// ---------- sun + shade ----------

// Sun position (SunCalc formulas). Returns altitude (rad) and compass bearing of the sun (deg, 0 = north).
function sunPosition(date, lat, lon) {
	const rad = Math.PI / 180, e = rad * 23.4397;
	const d = date.valueOf() / 864e5 - 0.5 + 2440588 - 2451545;
	const M = rad * (357.5291 + 0.98560028 * d);
	const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
	const dec = Math.asin(Math.sin(L) * Math.sin(e));
	const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
	const H = rad * (280.16 + 360.9856235 * d) - rad * -lon - ra;
	const phi = rad * lat;
	const azimuthFromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
	const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
	return {altitude, bearing: (azimuthFromSouth / rad + 180 + 360) % 360};
}

function buildingHeight(tags) {
	const h = parseFloat(tags.height);
	if (!Number.isNaN(h)) return h;
	const levels = parseFloat(tags['building:levels']);
	if (!Number.isNaN(levels)) return levels * 3.2 + 1;
	return tags.building === 'house' || tags.building === 'detached' ? 7 : 10;
}

async function getBuildings(coords, radius) {
	// Sample the route every ~60 m for Overpass' polyline "around" filter.
	const pts = [];
	let last = null;
	for (const c of coords) {
		if (!last || Math.hypot((c[0] - last[0]) * 111320, (c[1] - last[1]) * 90000) > 60) {
			pts.push(c);
			last = c;
		}
	}
	pts.push(coords[coords.length - 1]);
	const around = pts.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',');
	const q = `[out:json][timeout:40];way["building"](around:${radius},${around});out tags geom;`;
	return cached(`bld:${q}`, 6 * 3600e3, async () => {
		let res;
		for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter']) {
			try {
				res = await getJSON(endpoint, {method: 'POST', body: new URLSearchParams({data: q})});
				break;
			} catch (e) {
				console.warn('overpass retry', e.message);
			}
		}
		if (!res) throw new Error('building data unavailable (Overpass busy), try again');
		return res.elements.filter(e => e.geometry?.length > 2).map(e => ({h: buildingHeight(e.tags || {}), geom: e.geometry}));
	});
}

async function computeShade({coords, iso, duration_s}) {
	const when = iso ? new Date(iso) : new Date();
	const mid = coords[Math.floor(coords.length / 2)];
	const sun = sunPosition(when, mid[0], mid[1]);
	const altDeg = sun.altitude * 180 / Math.PI;

	// Local metric projection around the route midpoint
	const kx = 111320 * Math.cos(mid[0] * Math.PI / 180), ky = 110574;
	const toXY = (la, lo) => [(lo - mid[1]) * kx, (la - mid[0]) * ky];

	// Resample the route every 8 m
	const samples = [];
	let acc = 0;
	for (let i = 1; i < coords.length; i++) {
		const a = toXY(...coords[i - 1]), b = toXY(...coords[i]);
		const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
		for (let t = samples.length ? (8 - (acc % 8)) % 8 : 0; t < seg; t += 8) {
			samples.push({x: a[0] + (b[0] - a[0]) * t / seg, y: a[1] + (b[1] - a[1]) * t / seg, d: acc + t});
		}
		acc += seg;
	}

	if (altDeg <= 0.5) {
		return {sun: {altitude: altDeg, bearing: sun.bearing}, night: true, samples: samples.map(s => ({d: Math.round(s.d), shaded: true})), shadePct: 100, sunMinutes: 0, buildings: 0, length_m: Math.round(acc)};
	}

	const tanA = Math.tan(sun.altitude);
	const reach = Math.min(220, Math.max(40, 80 / tanA));
	const buildings = (await getBuildings(coords, Math.round(Math.min(reach, 160)))).map(b => {
		const poly = b.geom.map(g => toXY(g.lat, g.lon));
		const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
		return {h: b.h, poly, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
	});

	const CELL = 40;
	const grid = new Map();
	buildings.forEach((b, idx) => {
		for (let gx = Math.floor(b.minX / CELL); gx <= Math.floor(b.maxX / CELL); gx++) {
			for (let gy = Math.floor(b.minY / CELL); gy <= Math.floor(b.maxY / CELL); gy++) {
				const k = `${gx},${gy}`;
				if (!grid.has(k)) grid.set(k, []);
				grid.get(k).push(idx);
			}
		}
	});

	const inside = (x, y, poly) => {
		let c = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const [xi, yi] = poly[i], [xj, yj] = poly[j];
			if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
		}
		return c;
	};
	const blockerAt = (x, y, minH) => {
		const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
		if (!list) return false;
		for (const idx of list) {
			const b = buildings[idx];
			if (b.h > minH && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && inside(x, y, b.poly)) return true;
		}
		return false;
	};

	const br = sun.bearing * Math.PI / 180;
	const dx = Math.sin(br), dy = Math.cos(br);
	let shadedLen = 0;
	const out = samples.map(s => {
		let shaded = false;
		for (let t = 3; t <= reach && !shaded; t += 3) {
			shaded = blockerAt(s.x + dx * t, s.y + dy * t, t * tanA);
		}
		if (shaded) shadedLen += 8;
		return {d: Math.round(s.d), shaded};
	});
	const frac = samples.length ? shadedLen / (samples.length * 8) : 0;
	return {
		sun: {altitude: Math.round(altDeg * 10) / 10, bearing: Math.round(sun.bearing)},
		night: false,
		samples: out,
		shadePct: Math.round(frac * 100),
		sunMinutes: Math.round((duration_s || 0) * (1 - frac) / 60),
		shadowRatio: Math.round(100 / tanA) / 100, // shadow length per metre of height
		buildings: buildings.length,
		length_m: Math.round(acc)
	};
}

// ---------- agent ----------

const TOOLS = [
	{type: 'function', function: {name: 'search_place', description: 'Geocode a named place, landmark, address or area (e.g. "Tokyo Tower", "Shimokitazawa"). Returns candidates with lat/lon.',
		parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}}},
	{type: 'function', function: {name: 'find_nearby', description: `Find OpenStreetMap places of a category near a point, sorted by distance. Categories: ${Object.keys(CATEGORY_TAGS).join(', ')}.`,
		parameters: {type: 'object', properties: {lat: {type: 'number'}, lon: {type: 'number'}, category: {type: 'string'}, radius_m: {type: 'number', description: '100-3000, default 800'}}, required: ['lat', 'lon', 'category']}}},
	{type: 'function', function: {name: 'get_weather', description: 'Current weather plus 3-day forecast in 3-hour slots (rain/snow/fog/thunder chance %, cloud %, temp) and sunrise/sunset for a point.',
		parameters: {type: 'object', properties: {lat: {type: 'number'}, lon: {type: 'number'}}, required: ['lat', 'lon']}}},
	{type: 'function', function: {name: 'fly_to', description: 'Move the 3D camera. pitch 5-89 degrees (low = horizon view, high = top-down), yaw 0-360 compass heading, distance metres from target (150 close-up, 600 neighbourhood, 2500 district).',
		parameters: {type: 'object', properties: {lat: {type: 'number'}, lon: {type: 'number'}, pitch: {type: 'number'}, yaw: {type: 'number'}, distance: {type: 'number'}, label: {type: 'string'}}, required: ['lat', 'lon']}}},
	{type: 'function', function: {name: 'set_time', description: 'Set the map\'s simulated date/time (drives sun position, sky and lighting). ISO 8601 with timezone, e.g. 2026-09-11T17:56:00+09:00.',
		parameters: {type: 'object', properties: {iso: {type: 'string'}}, required: ['iso']}}},
	{type: 'function', function: {name: 'start_navigation', description: 'Plan a real walking or cycling route and start turn-by-turn navigation in the 3D map. For several destinations ("to Tokyo Tower then to Skytree") pass them ALL in order in `stops` (search each one first) — one route visits them in order and each stop is marked on the map. Starts from the user\'s location (or camera) unless from_lat/from_lon are given. Returns distance and duration.',
		parameters: {type: 'object', properties: {
			stops: {type: 'array', description: 'Ordered destinations; the last is the final one.', items: {type: 'object', properties: {lat: {type: 'number'}, lon: {type: 'number'}, label: {type: 'string'}}, required: ['lat', 'lon', 'label']}},
			lat: {type: 'number', description: 'Single destination (if no stops)'}, lon: {type: 'number'}, label: {type: 'string'},
			mode: {type: 'string', enum: ['walk', 'bike']}, from_lat: {type: 'number'}, from_lon: {type: 'number'}
		}, required: ['mode']}}},
	{type: 'function', function: {name: 'show_places', description: 'Pin a short list of places in the UI so the user can click to fly to each one.',
		parameters: {type: 'object', properties: {places: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'}, lat: {type: 'number'}, lon: {type: 'number'}, note: {type: 'string'}}, required: ['name', 'lat', 'lon']}}}, required: ['places']}}}
];

function systemPrompt(ctx) {
	const now = new Date().toLocaleString('sv-SE', {timeZone: 'Asia/Tokyo'}).replace(' ', 'T') + '+09:00';
	return `You are the guide inside a live 3D map of the real world (OpenStreetMap buildings, real sun position, live weather).
Current Tokyo time: ${now}. Camera is looking at lat ${ctx.lat?.toFixed?.(5)}, lon ${ctx.lon?.toFixed?.(5)}.
Always use tools for facts — never invent places, coordinates or weather. Typical flow: search_place / find_nearby -> get_weather when timing or outdoors matters -> fly_to the best answer (and set_time when the user asks about a moment like sunset or tonight) -> show_places for options.
When the user wants to go somewhere (walk, cycle, take me, directions), call start_navigation instead of fly_to; suggest cycling for >2 km and warn if rain is likely during the trip.
For trips with several destinations ("to A then B"), search_place each one, then call start_navigation ONCE with all of them in \`stops\`, in the order given.
Choose cinematic cameras: pitch 35-60, distance 250-900 for streets, 1500-4000 for districts.
Reply in the language the user wrote in (English if they wrote English, Japanese if Japanese), max 4 short sentences, concrete and friendly, plain text only (no markdown, no asterisks). Mention the weather when it affects the plan.`;
}

async function callAI(messages) {
	const r = await fetch(`${AI_BASE}/chat/completions`, {
		method: 'POST',
		headers: {'Authorization': `Bearer ${AI_KEY}`, 'Content-Type': 'application/json'},
		body: JSON.stringify({model: AI_MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.4, max_tokens: 900})
	});
	if (!r.ok) throw new Error(`ai& ${r.status}: ${(await r.text()).slice(0, 300)}`);
	return (await r.json()).choices[0].message;
}

async function runAgent({messages = [], camera = {}, me = null}) {
	if (!AI_KEY) throw new Error('AIAND_API_KEY is not set');
	const where = me && Number.isFinite(me.lat) ? ` The user's own location ("where I am") is lat ${(+me.lat).toFixed(5)}, lon ${(+me.lon).toFixed(5)}${me.label ? ` (${me.label})` : ''}.` : '';
	const convo = [{role: 'system', content: systemPrompt(camera) + where}, ...messages.slice(-12)];
	const actions = [];
	const trace = [];

	for (let step = 0; step < 6; step++) {
		const msg = await callAI(convo);
		// Send back only what the API accepts (reasoning_content and null fields are rejected by some models).
		convo.push(msg.tool_calls?.length
			? {role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls}
			: {role: 'assistant', content: msg.content || ''});
		if (!msg.tool_calls?.length) {
			return {reply: msg.content || '', actions, trace, model: AI_MODEL};
		}
		for (const call of msg.tool_calls) {
			let args = {};
			try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { /* model sent bad JSON */ }
			let result;
			try {
				switch (call.function.name) {
					case 'search_place': result = await searchPlace(args.query, camera.lat != null ? camera : null); break;
					case 'find_nearby': result = await findNearby(args.lat, args.lon, args.category, args.radius_m); break;
					case 'get_weather': result = await getWeather(args.lat, args.lon); break;
					case 'start_navigation': {
						const from = args.from_lat != null ? {lat: args.from_lat, lon: args.from_lon} : (me || camera);
						const stops = Array.isArray(args.stops) && args.stops.length ? args.stops : [{lat: args.lat, lon: args.lon, label: args.label}];
						const route = await getRouteVia(from, stops, args.mode);
						const label = stops.map(x => x.label).filter(Boolean).join(' → ') || args.label;
						actions.push({type: 'navigate', label, route});
						result = {ok: true, mode: route.mode, distance_m: route.distance_m, minutes: Math.round(route.duration_s / 60), stops: stops.map(x => x.label), first_steps: route.steps.slice(0, 3).map(x => x.text)};
						break;
					}
					case 'fly_to': case 'set_time': case 'show_places':
						actions.push({type: call.function.name, ...args});
						result = {ok: true};
						break;
					default: result = {error: `unknown tool ${call.function.name}`};
				}
			} catch (e) {
				result = {error: e.message};
			}
			trace.push(result && result.error ? {tool: call.function.name, args, error: result.error} : {tool: call.function.name, args});
			convo.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000)});
		}
	}
	return {reply: 'I ran out of steps — try a more specific question.', actions, trace, model: AI_MODEL};
}

// ---------- http ----------

function send(res, status, body, type = 'application/json') {
	res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
	res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
		req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
		req.on('error', reject);
	});
}

function serveStatic(req, res, pathname) {
	let file = path.normalize(path.join(BUILD_DIR, decodeURIComponent(pathname)));
	if (!file.startsWith(BUILD_DIR)) return send(res, 403, {error: 'forbidden'});
	fs.stat(file, (err, st) => {
		if (!err && st.isDirectory()) file = path.join(file, 'index.html');
		else if (err) file = path.join(BUILD_DIR, 'index.html');
		fs.readFile(file, (err2, buf) => {
			if (err2) return send(res, 404, 'Not found', 'text/plain');
			const ext = path.extname(file);
			res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'});
			res.end(buf);
		});
	});
}

http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost');
	try {
		if (url.pathname === '/api/health') return send(res, 200, {ok: true, ai: Boolean(AI_KEY), model: AI_MODEL});
		if (url.pathname === '/api/weather') {
			const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
			if (Number.isNaN(lat) || Number.isNaN(lon)) return send(res, 400, {error: 'lat and lon required'});
			return send(res, 200, await getWeather(lat, lon));
		}
		if (url.pathname === '/api/route') {
			const [fLat, fLon] = (url.searchParams.get('from') || '').split(',').map(Number);
			const [tLat, tLon] = (url.searchParams.get('to') || '').split(',').map(Number);
			if ([fLat, fLon, tLat, tLon].some(Number.isNaN)) return send(res, 400, {error: 'from=lat,lon and to=lat,lon required'});
			return send(res, 200, await getRoute({lat: fLat, lon: fLon}, {lat: tLat, lon: tLon}, url.searchParams.get('mode')));
		}
		if (url.pathname === '/api/shade' && req.method === 'POST') {
			const body = await readBody(req);
			if (!Array.isArray(body.coords) || body.coords.length < 2) return send(res, 400, {error: 'coords required'});
			return send(res, 200, await computeShade(body));
		}
		if (url.pathname === '/api/building') {
			const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
			if (Number.isNaN(lat) || Number.isNaN(lon)) return send(res, 400, {error: 'lat and lon required'});
			return send(res, 200, lookupBuilding(lat, lon)); // PLATEAU attributes; null outside coverage
		}
		if (url.pathname === '/api/building-name') {
			// Name of the named OSM outline that contains the point (landmarks first). Few PLATEAU records carry names.
			const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
			if (Number.isNaN(lat) || Number.isNaN(lon)) return send(res, 400, {error: 'lat and lon required'});
			const q = `[out:json][timeout:10];is_in(${lat.toFixed(6)},${lon.toFixed(6)})->.a;(area.a[building][name];area.a[man_made][name];area.a[tourism][name];area.a[amenity][name];area.a[railway][name];area.a[shop][name];area.a[office][name];area.a[leisure][name];);out tags;`;
			const best = await cached(`isin:${q}`, 24 * 3600e3, async () => {
				const r = await getJSON('https://overpass-api.de/api/interpreter', {method: 'POST', body: new URLSearchParams({data: q})});
				const score = t => (t.tourism ? 4 : 0) + (t.man_made ? 3 : 0) + (t.railway === 'station' ? 4 : 0) + (t.amenity ? 2 : 0) + (t['name:en'] ? 2 : 0) + (t.wikidata ? 3 : 0) + (t.building ? 1 : 0);
				const els = (r.elements || []).map(e => e.tags || {}).filter(t => t.name).sort((a, b) => score(b) - score(a));
				return els.length ? {name: els[0].name, name_en: els[0]['name:en'] || null} : null;
			});
			return send(res, 200, best);
		}
		if (url.pathname === '/api/sun') {
			const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
			const p = sunPosition(url.searchParams.get('iso') ? new Date(url.searchParams.get('iso')) : new Date(), lat, lon);
			return send(res, 200, {altitude: p.altitude * 180 / Math.PI, bearing: p.bearing});
		}
		const osmMatch = url.pathname.match(/^\/api\/osm\/(way|relation|node)\/(\d{1,15})$/);
		if (osmMatch) {
			let feature;
			try {
				feature = await getOSMFeature(osmMatch[1], Number(osmMatch[2]));
			} catch (e) {
				if (/HTTP (404|410)|not found/.test(e.message)) return send(res, 404, {error: e.message});
				throw e;
			}
			res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400'});
			return res.end(JSON.stringify(feature));
		}
		if (url.pathname === '/api/agent' && req.method === 'POST') {
			return send(res, 200, await runAgent(await readBody(req)));
		}
		if (url.pathname.startsWith('/api/')) return send(res, 404, {error: 'not found'});
		return serveStatic(req, res, url.pathname);
	} catch (e) {
		console.error(url.pathname, e);
		return send(res, 502, {error: e.message});
	}
}).listen(PORT, () => console.log(`streets-gl + ai& guide on :${PORT} (model ${AI_MODEL}, key ${AI_KEY ? 'set' : 'MISSING'})`));
