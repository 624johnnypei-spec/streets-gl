import React, {useCallback, useContext, useEffect, useRef, useState} from "react";
import {ActionsContext} from "~/app/ui/UI";
import UIActions from "~/app/ui/UIActions";
import styles from './GuideLayer.scss';
import WeatherFX, {lookFromWeather, PRESETS, WeatherKind, WeatherLook} from "./WeatherFX";
import {formatDistance, formatDuration, haversine, LatLon, lerpAngle, Route, RoutePath} from "./geo";

// Map yaw is degrees with 0 = north-up; YAW_SIGN converts a compass bearing into it.
const YAW_SIGN = 1;
const FOLLOW_PITCH = 45;
const FOLLOW_DISTANCE = 240;
const FOLLOW_LEAD = 28; // look slightly ahead so the traveller sits in the lower third, Tesla-style
const SPEED_MS = {walk: 1.4, bike: 4.6};
const MULTIPLIERS = [1, 5, 15, 40];

interface WeatherHour {
	time: string;
	tempC: number;
	desc: string;
	code: number;
	rain: number;
	snow: number;
	thunder: number;
	cloud: number;
}

interface Weather {
	area?: string;
	now: {tempC: number; feelsC: number; desc: string; code: number; humidity: number; cloud: number; precipMM: number; windKmph: number; windDir: string};
	days: {date: string; sunrise: string; sunset: string; hourly: WeatherHour[]}[];
}

interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	tools?: string[];
}

interface Place {
	name: string;
	lat: number;
	lon: number;
	note?: string;
}

type AgentAction =
	| {type: 'fly_to'; lat: number; lon: number; pitch?: number; yaw?: number; distance?: number; label?: string}
	| {type: 'set_time'; iso: string}
	| {type: 'show_places'; places: Place[]}
	| {type: 'navigate'; label?: string; route: Route};

type NavPhase = 'idle' | 'overview' | 'follow' | 'paused' | 'arrived';

interface NavState {
	path: RoutePath;
	label: string;
	from: LatLon;
	to: LatLon;
	traveled: number;
	heading: number;
	phase: NavPhase;
	multiplier: number;
	pendingCamera: [number, number, number, number, number] | null;
}

interface Hud {
	next: string;
	inMetres: number;
	remaining: number;
	etaSeconds: number;
}

const KIND_ICON: Record<WeatherKind, string> = {clear: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️'};
const TOOL_ICON: Record<string, string> = {search_place: '🔎', find_nearby: '📍', get_weather: '☁️', fly_to: '🎥', set_time: '🕒', show_places: '📌', start_navigation: '🧭'};

function readCamera(actions: UIActions): {lat: number; lon: number; pitch: number; yaw: number; distance: number} {
	let hash = '';
	try {
		hash = actions.getControlsStateHash(); // throws until the camera has been initialised
	} catch (e) {
		hash = window.location.hash.replace('#', '');
	}
	const [lat, lon, pitch, yaw, distance] = hash.split(',').map(Number);
	return {lat, lon, pitch, yaw, distance};
}

function maneuverIcon(text: string): string {
	const t = text.toLowerCase();
	if (t.includes('arrive')) return '🏁';
	if (t.includes('sharp left') || t.includes('uturn')) return '↰';
	if (t.includes('left')) return '⬅';
	if (t.includes('sharp right')) return '↱';
	if (t.includes('right')) return '➡';
	if (t.includes('roundabout')) return '⟳';
	return '⬆';
}

function upcomingHours(weather: Weather | null, count: number): WeatherHour[] {
	if (!weather) return [];
	const now = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Tokyo'}));
	const nowMin = now.getHours() * 60 + now.getMinutes();
	const today = weather.days[0]?.hourly ?? [];
	const tomorrow = weather.days[1]?.hourly ?? [];
	const toMin = (h: WeatherHour): number => parseInt(h.time.slice(0, 2)) * 60 + parseInt(h.time.slice(3, 5));
	return [...today.filter(h => toMin(h) + 180 > nowMin), ...tomorrow].slice(0, count);
}

const GuideLayer: React.FC = () => {
	const actions = useContext(ActionsContext);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const avatarRef = useRef<HTMLDivElement>(null);
	const chevronRef = useRef<HTMLDivElement>(null);
	const fxRef = useRef(new WeatherFX());
	const lookRef = useRef<WeatherLook>(PRESETS.clear);
	const navRef = useRef<NavState | null>(null);
	const placesRef = useRef<Place[]>([]);
	const weatherFetchRef = useRef<{lat: number; lon: number; at: number} | null>(null);

	const [weather, setWeather] = useState<Weather | null>(null);
	const [weatherMode, setWeatherMode] = useState<string>('live');
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState<string>('');
	const [busy, setBusy] = useState<boolean>(false);
	const [places, setPlaces] = useState<Place[]>([]);
	const [navPhase, setNavPhase] = useState<NavPhase>('idle');
	const [navMode, setNavMode] = useState<'walk' | 'bike'>('walk');
	const [multiplier, setMultiplier] = useState<number>(15);
	const [hud, setHud] = useState<Hud | null>(null);
	const [routeInfo, setRouteInfo] = useState<{label: string; distance: number; duration: number} | null>(null);
	const [chatOpen, setChatOpen] = useState<boolean>(true);

	// ---------- weather ----------

	const refreshWeather = useCallback(async (force: boolean = false): Promise<void> => {
		const cam = readCamera(actions);
		if (Number.isNaN(cam.lat)) return;
		const last = weatherFetchRef.current;
		const moved = last ? haversine([last.lat, last.lon], [cam.lat, cam.lon]) : Infinity;
		if (!force && last && moved < 3000 && Date.now() - last.at < 10 * 60e3) return;
		weatherFetchRef.current = {lat: cam.lat, lon: cam.lon, at: Date.now()};
		try {
			const r = await fetch(`/api/weather?lat=${cam.lat.toFixed(3)}&lon=${cam.lon.toFixed(3)}`);
			if (r.ok) setWeather(await r.json());
		} catch (e) {
			console.warn('weather fetch failed', e);
		}
	}, [actions]);

	useEffect(() => {
		const first = setTimeout((): void => void refreshWeather(true), 1500);
		const timer = setInterval((): void => void refreshWeather(), 20e3);
		return (): void => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, [refreshWeather]);

	useEffect(() => {
		if (weatherMode !== 'live') {
			lookRef.current = PRESETS[weatherMode];
		} else if (weather) {
			const n = weather.now;
			lookRef.current = lookFromWeather(n.code, n.precipMM, n.cloud, n.windKmph);
		} else {
			lookRef.current = PRESETS.clear;
		}
	}, [weather, weatherMode]);

	// ---------- navigation ----------

	const showOverview = useCallback((): void => {
		const nav = navRef.current;
		if (!nav) return;
		const {center, extentMetres} = nav.path.bounds();
		// Past ~4 km streets-gl switches to its flat slippy map, which suits a whole-route overview.
		const distance = Math.min(Math.max(extentMetres * 2.2, 600), 12000);
		nav.phase = 'overview';
		nav.pendingCamera = [center[0], center[1], 89.9, 0, distance];
		setNavPhase('overview');
	}, [actions]);

	const startRoute = useCallback((route: Route, label: string, from: LatLon, to: LatLon): void => {
		const path = new RoutePath(route);
		navRef.current = {path, label, from, to, traveled: 0, heading: path.headingAt(0), phase: 'overview', multiplier, pendingCamera: null};
		setNavMode(route.mode);
		setRouteInfo({label, distance: route.distance_m, duration: route.duration_s});
		setHud(null);
		showOverview();
	}, [multiplier, showOverview]);

	const routeTo = useCallback(async (to: LatLon, mode: 'walk' | 'bike', label: string, fromOverride?: LatLon): Promise<void> => {
		const cam = readCamera(actions);
		const from: LatLon = fromOverride ?? [cam.lat, cam.lon];
		try {
			const r = await fetch(`/api/route?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}&mode=${mode}`);
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			startRoute(data as Route, label, from, to);
		} catch (e) {
			setMessages(m => [...m, {role: 'assistant', content: `Couldn't find a ${mode} route: ${(e as Error).message}`}]);
		}
	}, [actions, startRoute]);

	const switchMode = useCallback((mode: 'walk' | 'bike'): void => {
		const nav = navRef.current;
		setNavMode(mode);
		if (nav && nav.path.route.mode !== mode) {
			void routeTo(nav.to, mode, nav.label, nav.from);
		}
	}, [routeTo]);

	const beginFollow = useCallback((): void => {
		const nav = navRef.current;
		if (!nav) return;
		if (nav.phase === 'arrived') nav.traveled = 0;
		nav.phase = 'follow';
		setNavPhase('follow');
	}, []);

	const pause = useCallback((): void => {
		const nav = navRef.current;
		if (!nav) return;
		nav.phase = 'paused';
		setNavPhase('paused');
	}, []);

	const endRoute = useCallback((): void => {
		navRef.current = null;
		setNavPhase('idle');
		setRouteInfo(null);
		setHud(null);
	}, []);

	useEffect(() => {
		if (navRef.current) navRef.current.multiplier = multiplier;
	}, [multiplier]);

	// ---------- render loop: weather FX, route line, pins, traveller, follow camera ----------

	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		let hudTimer = 0;

		const frame = (now: number): void => {
			raf = requestAnimationFrame(frame);
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;

			try {
				drawFrame(dt);
			} catch (e) {
				console.warn('guide frame', e);
			}
		};

		const drawFrame = (dt: number): void => {
			const canvas = canvasRef.current;
			const ctx = canvas?.getContext('2d');

			if (canvas && ctx) {
				const dpr = Math.min(window.devicePixelRatio || 1, 2);
				const w = window.innerWidth;
				const h = window.innerHeight;

				if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
					canvas.width = Math.round(w * dpr);
					canvas.height = Math.round(h * dpr);
				}

				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, w, h);

				const nav = navRef.current;

				if (nav) {
					// Camera moves requested before the map finished initialising are retried here.
					if (nav.pendingCamera) {
						try {
							actions.goToState(...nav.pendingCamera);
							nav.pendingCamera = null;
						} catch (e) {
							// controls not ready yet
						}
					}

					if (nav.phase === 'follow') {
						nav.traveled += SPEED_MS[nav.path.route.mode] * nav.multiplier * dt;

						if (nav.traveled >= nav.path.length) {
							nav.traveled = nav.path.length;
							nav.phase = 'arrived';
							setNavPhase('arrived');
						}
					}

					const pos = nav.path.pointAt(nav.traveled);
					nav.heading = lerpAngle(nav.heading, nav.path.headingAt(nav.traveled, 35), 1 - Math.pow(0.04, dt));

					if (nav.phase === 'follow') {
						const hr = nav.heading * Math.PI / 180;
						const lead: LatLon = [
							pos[0] + Math.cos(hr) * FOLLOW_LEAD / 111320,
							pos[1] + Math.sin(hr) * FOLLOW_LEAD / (111320 * Math.cos(pos[0] * Math.PI / 180))
						];
						actions.goToState(lead[0], lead[1], FOLLOW_PITCH, (YAW_SIGN * nav.heading + 360) % 360, FOLLOW_DISTANCE);
					}

					drawRoute(ctx, actions, nav);

					const screen = actions.projectLatLon(pos[0], pos[1]);
					const ahead = nav.path.pointAt(nav.traveled + 12);
					const screenAhead = actions.projectLatLon(ahead[0], ahead[1]);

					if (avatarRef.current) {
						if (screen) {
							avatarRef.current.style.display = 'block';
							avatarRef.current.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
						} else {
							avatarRef.current.style.display = 'none';
						}
					}

					if (chevronRef.current && screen && screenAhead) {
						const angle = Math.atan2(screenAhead[1] - screen[1], screenAhead[0] - screen[0]) * 180 / Math.PI + 90;
						chevronRef.current.style.transform = `rotate(${angle}deg)`;
					}

					hudTimer += dt;

					if (hudTimer > 0.25) {
						hudTimer = 0;
						const next = nav.path.nextStep(nav.traveled);
						const remaining = nav.path.length - nav.traveled;
						setHud({
							next: next?.step.text ?? 'Arrive at destination',
							inMetres: next?.inMetres ?? remaining,
							remaining,
							etaSeconds: nav.path.route.duration_s * remaining / Math.max(nav.path.length, 1)
						});
					}
				} else if (avatarRef.current) {
					avatarRef.current.style.display = 'none';
				}

				drawPins(ctx, actions, placesRef.current);
				fxRef.current.draw(ctx, dt, w, h, lookRef.current);
			}
		};

		raf = requestAnimationFrame(frame);
		return (): void => cancelAnimationFrame(raf);
	}, [actions]);

	useEffect(() => {
		placesRef.current = places;
	}, [places]);

	// ---------- AI agent ----------

	const applyActions = useCallback((list: AgentAction[]): void => {
		for (const a of list) {
			if (a.type === 'fly_to') {
				if (navRef.current?.phase === 'follow') pause();
				const cam = readCamera(actions);
				actions.goToState(a.lat, a.lon, a.pitch ?? 50, a.yaw ?? cam.yaw, a.distance ?? 600);
			} else if (a.type === 'set_time') {
				const t = Date.parse(a.iso);
				if (!Number.isNaN(t)) actions.setTime(t);
			} else if (a.type === 'show_places') {
				setPlaces(a.places ?? []);
			} else if (a.type === 'navigate' && a.route) {
				const c = a.route.coords;
				startRoute(a.route, a.label ?? 'Destination', c[0], c[c.length - 1]);
			}
		}
	}, [actions, pause, startRoute]);

	const send = useCallback(async (text: string): Promise<void> => {
		const content = text.trim();
		if (!content || busy) return;
		const history = [...messages, {role: 'user' as const, content}];
		setMessages(history);
		setInput('');
		setBusy(true);
		try {
			const r = await fetch('/api/agent', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({messages: history.map(m => ({role: m.role, content: m.content})), camera: readCamera(actions)})
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			setMessages(m => [...m, {role: 'assistant', content: data.reply || '(done)', tools: (data.trace ?? []).map((t: {tool: string}) => t.tool)}]);
			applyActions(data.actions ?? []);
		} catch (e) {
			setMessages(m => [...m, {role: 'assistant', content: `⚠️ ${(e as Error).message}`}]);
		} finally {
			setBusy(false);
		}
	}, [actions, applyActions, busy, messages]);

	// Console / fallback hook: guide.routeTo([35.6812, 139.7671], 'bike', 'Tokyo Station')
	useEffect(() => {
		(window as any).guide = {routeTo, send, setWeatherMode, beginFollow, showOverview, actions, nav: navRef};
	}, [routeTo, send, beginFollow, showOverview, actions]);

	// ---------- view ----------

	const look = weatherMode === 'live' && weather
		? lookFromWeather(weather.now.code, weather.now.precipMM, weather.now.cloud, weather.now.windKmph)
		: PRESETS[weatherMode] ?? PRESETS.clear;
	const hours = upcomingHours(weather, 4);
	const tripRain = hours.slice(0, 2).some(h => h.rain >= 50 || h.thunder >= 30);
	const stopKeys = (e: React.KeyboardEvent): void => e.stopPropagation();

	return <>
		<canvas ref={canvasRef} className={styles.overlay}/>

		<div ref={avatarRef} className={styles.avatar} style={{display: 'none'}}>
			<div ref={chevronRef} className={styles.avatar__chevron}/>
			<div className={`${styles.avatar__icon} ${navPhase === 'follow' ? styles['avatar__icon--moving'] : ''}`}>
				{navMode === 'bike' ? '🚴' : '🚶'}
			</div>
		</div>

		<div className={styles.weather}>
			<div className={styles.weather__main}>
				<span className={styles.weather__icon}>{KIND_ICON[look.kind]}</span>
				<div>
					<div className={styles.weather__temp}>{weather ? `${weather.now.tempC}°` : '--°'}</div>
					<div className={styles.weather__desc}>{weatherMode === 'live' ? (weather?.now.desc ?? 'Loading weather…') : `Preview: ${weatherMode}`}</div>
				</div>
			</div>
			{weather && <div className={styles.weather__meta}>
				{weather.area && <span>📍 {weather.area}</span>}
				<span>💧 {weather.now.humidity}%</span>
				<span>💨 {weather.now.windKmph} km/h {weather.now.windDir}</span>
				<span>🌇 {weather.days[0]?.sunset}</span>
			</div>}
			{hours.length > 0 && <div className={styles.weather__hours}>
				{hours.map(h => <div key={h.time + h.desc} className={styles.weather__hour}>
					<b>{h.time}</b>
					<span>{h.tempC}°</span>
					<span className={h.rain >= 50 ? styles.wet : ''}>☔ {h.rain}%</span>
				</div>)}
			</div>}
			<div className={styles.weather__modes}>
				{['live', 'clear', 'rain', 'storm', 'snow', 'fog'].map(m => <button
					key={m}
					className={weatherMode === m ? styles.active : ''}
					onClick={(): void => setWeatherMode(m)}
				>{m === 'live' ? 'Live' : KIND_ICON[m as WeatherKind]}</button>)}
			</div>
		</div>

		{navPhase !== 'idle' && hud && <div className={styles.banner}>
			<div className={styles.banner__arrow}>{navPhase === 'arrived' ? '🏁' : maneuverIcon(hud.next)}</div>
			<div>
				<div className={styles.banner__dist}>{navPhase === 'arrived' ? 'Arrived' : formatDistance(hud.inMetres)}</div>
				<div className={styles.banner__text}>{navPhase === 'arrived' ? routeInfo?.label : hud.next}</div>
			</div>
		</div>}

		{navPhase !== 'idle' && routeInfo && <div className={styles.navbar}>
			<div className={styles.navbar__stats}>
				<b>{formatDuration(hud ? hud.etaSeconds : routeInfo.duration)}</b>
				<span>{formatDistance(hud ? hud.remaining : routeInfo.distance)} · {routeInfo.label}</span>
				{tripRain && <span className={styles.wet}>☔ rain likely on the way</span>}
			</div>
			<div className={styles.navbar__group}>
				<button className={navMode === 'walk' ? styles.active : ''} onClick={(): void => switchMode('walk')}>🚶</button>
				<button className={navMode === 'bike' ? styles.active : ''} onClick={(): void => switchMode('bike')}>🚴</button>
			</div>
			<div className={styles.navbar__group}>
				{MULTIPLIERS.map(x => <button key={x} className={multiplier === x ? styles.active : ''} onClick={(): void => setMultiplier(x)}>{x}×</button>)}
			</div>
			<div className={styles.navbar__group}>
				<button onClick={showOverview}>🗺 Overview</button>
				{navPhase === 'follow'
					? <button onClick={pause}>⏸ Pause</button>
					: <button className={styles.primary} onClick={beginFollow}>{navPhase === 'arrived' ? '↺ Replay' : '▶ Go'}</button>}
				<button onClick={endRoute}>✕</button>
			</div>
		</div>}

		<div className={`${styles.chat} ${chatOpen ? '' : styles['chat--closed']}`}>
			<div className={styles.chat__header} onClick={(): void => setChatOpen(!chatOpen)}>
				<span>✨ Ask the map</span>
				<small>ai&amp; · Japan-hosted</small>
			</div>
			{chatOpen && <>
				<div className={styles.chat__log}>
					{messages.length === 0 && <div className={styles.chat__hint}>
						{['Cycle me to Tokyo Station', 'Quiet café near here where I stay dry at 6pm', 'Show Tokyo Tower at sunset'].map(s =>
							<button key={s} onClick={(): void => void send(s)}>{s}</button>)}
					</div>}
					{messages.slice(-8).map((m, i) => <div key={i} className={`${styles.msg} ${m.role === 'user' ? styles['msg--user'] : ''}`}>
						{m.content}
						{m.tools && m.tools.length > 0 && <div className={styles.msg__tools}>
							{m.tools.map((t, j) => <span key={j}>{TOOL_ICON[t] ?? '•'} {t}</span>)}
						</div>}
					</div>)}
					{busy && <div className={styles.msg}><span className={styles.dots}>thinking</span></div>}
				</div>
				{places.length > 0 && <div className={styles.places}>
					{places.slice(0, 6).map(p => <div key={`${p.name}${p.lat}`} className={styles.place}>
						<button className={styles.place__name} onClick={(): void => actions.goToState(p.lat, p.lon, 50, readCamera(actions).yaw, 350)}>
							<b>{p.name}</b>{p.note && <small>{p.note}</small>}
						</button>
						<button onClick={(): void => void routeTo([p.lat, p.lon], 'walk', p.name)}>🚶</button>
						<button onClick={(): void => void routeTo([p.lat, p.lon], 'bike', p.name)}>🚴</button>
					</div>)}
				</div>}
				<form className={styles.chat__form} onSubmit={(e): void => {
					e.preventDefault();
					void send(input);
				}}>
					<input
						value={input}
						placeholder="Where to? 行きたい場所は？"
						onChange={(e): void => setInput(e.target.value)}
						onKeyDown={stopKeys}
						onKeyUp={stopKeys}
					/>
					<button type="submit" disabled={busy}>➤</button>
				</form>
			</>}
		</div>
	</>;
};

function drawRoute(ctx: CanvasRenderingContext2D, actions: UIActions, nav: NavState): void {
	const {coords, cumulative} = nav.path;
	const strokePass = (from: number, to: number, color: string, width: number): void => {
		ctx.beginPath();
		let penDown = false;
		for (let i = 0; i < coords.length; i++) {
			if (cumulative[i] < from - 1 || cumulative[i] > to + 1) {
				continue;
			}
			const p = actions.projectLatLon(coords[i][0], coords[i][1]);
			if (!p) {
				penDown = false;
				continue;
			}
			if (penDown) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
			penDown = true;
		}
		ctx.strokeStyle = color;
		ctx.lineWidth = width;
		ctx.stroke();
	};

	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';

	const traveledEnd = nav.traveled;

	strokePass(0, traveledEnd, 'rgba(120, 130, 150, 0.55)', 6);
	strokePass(traveledEnd, nav.path.length, 'rgba(255, 255, 255, 0.9)', 11);
	strokePass(traveledEnd, nav.path.length, '#2f7bff', 7);

	const end = coords[coords.length - 1];
	const pin = actions.projectLatLon(end[0], end[1]);
	if (pin) {
		ctx.fillStyle = '#ff3b5c';
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.arc(pin[0], pin[1] - 18, 9, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(pin[0], pin[1]);
		ctx.lineTo(pin[0], pin[1] - 9);
		ctx.stroke();
	}

}

function drawPins(ctx: CanvasRenderingContext2D, actions: UIActions, places: Place[]): void {
	ctx.font = '600 12px Inter, sans-serif';
	ctx.textAlign = 'center';
	for (const p of places.slice(0, 8)) {
		const s = actions.projectLatLon(p.lat, p.lon);
		if (!s || s[0] < -50 || s[1] < -50 || s[0] > window.innerWidth + 50 || s[1] > window.innerHeight + 50) {
			continue;
		}
		ctx.fillStyle = '#ffb020';
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(s[0], s[1] - 12, 6, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		const label = p.name.length > 22 ? p.name.slice(0, 21) + '…' : p.name;
		const w = ctx.measureText(label).width + 12;
		ctx.fillStyle = 'rgba(15, 20, 30, 0.78)';
		ctx.beginPath();
		ctx.roundRect(s[0] - w / 2, s[1] - 42, w, 20, 6);
		ctx.fill();
		ctx.fillStyle = '#fff';
		ctx.fillText(label, s[0], s[1] - 28);
	}
}

export default React.memo(GuideLayer);
