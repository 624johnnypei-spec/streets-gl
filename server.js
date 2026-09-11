// Serves the built map and two APIs:
//   GET  /api/weather?lat=&lon=   condensed wttr.in forecast (cached 10 min)
//   POST /api/agent               ai& tool-calling agent that searches places, reads weather,
//                                 and returns camera/time actions for the 3D map to apply.
const http = require('http');
const fs = require('fs');
const path = require('path');

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

async function searchPlace(query, near) {
	const params = new URLSearchParams({q: query, format: 'jsonv2', limit: '5', 'accept-language': 'en,ja'});
	if (near) {
		const d = 0.25;
		params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
	}
	return cached(`geo:${params}`, 60 * 60e3, async () => {
		const res = await getJSON(`https://nominatim.openstreetmap.org/search?${params}`);
		return res.map(p => ({name: p.name || p.display_name.split(',')[0], address: p.display_name, lat: +p.lat, lon: +p.lon, kind: `${p.category}/${p.type}`}));
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
	{type: 'function', function: {name: 'show_places', description: 'Pin a short list of places in the UI so the user can click to fly to each one.',
		parameters: {type: 'object', properties: {places: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'}, lat: {type: 'number'}, lon: {type: 'number'}, note: {type: 'string'}}, required: ['name', 'lat', 'lon']}}}, required: ['places']}}}
];

function systemPrompt(ctx) {
	const now = new Date().toLocaleString('sv-SE', {timeZone: 'Asia/Tokyo'}).replace(' ', 'T') + '+09:00';
	return `You are the guide inside a live 3D map of the real world (OpenStreetMap buildings, real sun position, live weather).
Current Tokyo time: ${now}. Camera is looking at lat ${ctx.lat?.toFixed?.(5)}, lon ${ctx.lon?.toFixed?.(5)}.
Always use tools for facts — never invent places, coordinates or weather. Typical flow: search_place / find_nearby -> get_weather when timing or outdoors matters -> fly_to the best answer (and set_time when the user asks about a moment like sunset or tonight) -> show_places for options.
Choose cinematic cameras: pitch 35-60, distance 250-900 for streets, 1500-4000 for districts.
Reply in the user's language (Japanese or English), max 4 short sentences, concrete and friendly. Mention the weather when it affects the plan.`;
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

async function runAgent({messages = [], camera = {}}) {
	if (!AI_KEY) throw new Error('AIAND_API_KEY is not set');
	const convo = [{role: 'system', content: systemPrompt(camera)}, ...messages.slice(-12)];
	const actions = [];
	const trace = [];

	for (let step = 0; step < 6; step++) {
		const msg = await callAI(convo);
		convo.push(msg);
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
					case 'fly_to': case 'set_time': case 'show_places':
						actions.push({type: call.function.name, ...args});
						result = {ok: true};
						break;
					default: result = {error: `unknown tool ${call.function.name}`};
				}
			} catch (e) {
				result = {error: e.message};
			}
			trace.push({tool: call.function.name, args});
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
