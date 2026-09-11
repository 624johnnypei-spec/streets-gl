import React, {useCallback, useContext, useEffect, useRef, useState} from "react";
import {useRecoilState, useRecoilValue} from "recoil";
import SunCalc from 'suncalc';
import {ActionsContext, AtomsContext} from "~/app/ui/UI";
import UIActions from "~/app/ui/UIActions";
import styles from './GuideLayer.scss';
import WeatherFX, {lookFromWeather, PRESETS, WeatherKind, WeatherLook} from "./WeatherFX";
import Traveller3D, {PrecipState} from "./Traveller3D";
import {formatDistance, LatLon, lerpAngle, offsetRoute, Route, RoutePath, haversine} from "./geo";

// Map yaw is degrees with 0 = north-up; YAW_SIGN converts a compass bearing into it.
const YAW_SIGN = 1;
const FOLLOW_PITCH = 45;
const FOLLOW_DISTANCE = 240;
const FOLLOW_LEAD = 28; // look slightly ahead so the traveller sits in the lower third, Tesla-style
const SPEED_MS = {walk: 1.4, bike: 4.6};
const MULTIPLIERS = [1, 5, 15, 40];
const TOKYO: LatLon = [35.6812, 139.7671];

const ROUTE_SHADE = '#2F5D9E';
const ROUTE_SUN = '#E8A33D';
const ROUTE_NIGHT = '#8FB4E0';

type Phase = 'day' | 'golden' | 'twilight' | 'night';
const PHASE_LABEL: Record<Phase, string> = {day: 'Daytime', golden: 'Golden hour', twilight: 'Twilight', night: 'Night'};

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

interface ShadeResult {
	sun: {altitude: number; bearing: number};
	night: boolean;
	samples: {d: number; shaded: boolean}[];
	shadePct: number;
	sunMinutes: number;
	shadowRatio?: number;
	buildings: number;
	at: number;
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
	shade: ShadeResult | null;
}

interface Hud {
	next: string;
	inMetres: number;
	remaining: number;
	etaSeconds: number;
	inShade: boolean | null;
}

const KIND_ICON: Record<WeatherKind, string> = {clear: '☀︎', cloudy: '☁︎', rain: '☂︎', storm: 'ϟ', snow: '❄︎', fog: '≋'};
const TOOL_LABEL: Record<string, string> = {search_place: 'search', find_nearby: 'nearby', get_weather: 'weather', fly_to: 'camera', set_time: 'time', show_places: 'places', start_navigation: 'route'};
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

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

function maneuverGlyph(text: string): string {
	const t = text.toLowerCase();
	if (t.includes('arrive')) return '◎';
	if (t.includes('uturn')) return '↶';
	if (t.includes('left')) return '←';
	if (t.includes('right')) return '→';
	if (t.includes('roundabout')) return '⟳';
	return '↑';
}

function tokyoClock(ms: number): string {
	return new Date(ms).toLocaleTimeString('en-GB', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'});
}

function upcomingHours(weather: Weather | null, count: number): WeatherHour[] {
	if (!weather) return [];
	const now = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Tokyo'}));
	const nowMin = now.getHours() * 60 + now.getMinutes();
	const toMin = (h: WeatherHour): number => parseInt(h.time.slice(0, 2)) * 60 + parseInt(h.time.slice(3, 5));
	const today = weather.days[0]?.hourly ?? [];
	return [...today.filter(h => toMin(h) + 180 > nowMin), ...(weather.days[1]?.hourly ?? [])].slice(0, count);
}

// wttr.in gives "05:55 PM"; show 24-hour "17:55".
function to24h(t?: string): string {
	const m = t?.match(/(\d+):(\d+)\s*(AM|PM)/i);
	if (!m) return t ?? '–';
	let h = parseInt(m[1]) % 12;
	if (m[3].toUpperCase() === 'PM') h += 12;
	return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function phaseFor(altitudeDeg: number): Phase {
	if (altitudeDeg > 12) return 'day';
	if (altitudeDeg > 0) return 'golden';
	if (altitudeDeg > -8) return 'twilight';
	return 'night';
}

function viaStreet(route: Route): string {
	const named = route.steps.filter(s => s.text.includes(' onto ')).sort((a, b) => b.distance_m - a.distance_m)[0];
	return named ? named.text.split(' onto ')[1] : '';
}

function shadedAt(shade: ShadeResult | null, d: number): boolean | null {
	if (!shade || !shade.samples.length) return null;
	if (shade.night) return true;
	const i = Math.min(shade.samples.length - 1, Math.max(0, Math.round(d / 8)));
	return shade.samples[i].shaded;
}

// Re-renders every frame with the map clock, but only reports minute changes upward.
const MapClock: React.FC<{onMinute: (t: number) => void; forceLive: number}> = ({onMinute, forceLive}) => {
	const atoms = useContext(AtomsContext);
	const mapTime = useRecoilValue(atoms.mapTime);
	const [, setTimeMode] = useRecoilState(atoms.mapTimeMode);
	// Real sun + real weather is the point of this layer: start (and re-enter after set_time) in Dynamic mode.
	useEffect(() => setTimeMode(0), [forceLive]);
	const minute = Math.floor(mapTime / 60000);
	useEffect(() => onMinute(mapTime), [minute]);
	return null;
};

// Demo moments. Times resolve against Tokyo's real sun for the map's current day.
interface Demo {
	id: string;
	label: string;
	glyph: string;
	weather: string;
	at: ((t: ReturnType<typeof SunCalc.getTimes>, day: string) => number) | null;
	ride?: boolean;
}

const hhmm = (day: string, time: string): number => Date.parse(`${day}T${time}:00+09:00`);
const DEMOS: Demo[] = [
	{id: 'live', label: 'Live', glyph: '●', weather: 'live', at: null},
	{id: 'sunrise', label: 'Sunrise', glyph: '◒', weather: 'clear', at: (t): number => t.sunrise.getTime() + 12 * 60e3},
	{id: 'morning', label: 'Morning', glyph: '◔', weather: 'clear', at: (t, d): number => hhmm(d, '08:30')},
	{id: 'noon', label: 'Noon', glyph: '○', weather: 'clear', at: (t): number => t.solarNoon.getTime()},
	{id: 'afternoon', label: 'Afternoon', glyph: '◕', weather: 'clear', at: (t, d): number => hhmm(d, '15:00')},
	{id: 'golden', label: 'Golden hour', glyph: '◓', weather: 'clear', at: (t): number => t.sunset.getTime() - 25 * 60e3},
	{id: 'twilight', label: 'Twilight', glyph: '◐', weather: 'clear', at: (t): number => t.sunset.getTime() + 18 * 60e3},
	{id: 'night', label: 'Night', glyph: '●', weather: 'clear', at: (t, d): number => hhmm(d, '21:30')},
	{id: 'rain', label: 'Rain', glyph: '☂︎', weather: 'rain', at: (t, d): number => hhmm(d, '16:30')},
	{id: 'storm', label: 'Night storm', glyph: 'ϟ', weather: 'storm', at: (t, d): number => hhmm(d, '20:00')},
	{id: 'snow', label: 'Snow', glyph: '❄︎', weather: 'snow', at: (t, d): number => hhmm(d, '10:30')},
	{id: 'fog', label: 'Fog', glyph: '≋', weather: 'fog', at: (t): number => t.sunrise.getTime() + 50 * 60e3},
	{id: 'shade', label: 'Shade ride', glyph: '▮', weather: 'clear', at: (t, d): number => hhmm(d, '15:00'), ride: true}
];

// Sun path from sunrise to sunset with the current sun (or a sub-horizon marker at night).
const SunArc: React.FC<{time: number; at: LatLon; altitude: number}> = ({time, at, altitude}) => {
	const times = SunCalc.getTimes(new Date(time), at[0], at[1]);
	const rise = times.sunrise.getTime(), set = times.sunset.getTime();
	const f = Math.min(1, Math.max(0, (time - rise) / (set - rise)));
	const up = altitude > 0;
	const W = 268, H = 74, cx = W / 2, r = 108, base = 66;
	const ang = Math.PI * (1 - f);
	const sx = cx + Math.cos(ang) * r, sy = base - Math.sin(ang) * (base - 8);
	return <svg className={styles.arc} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sun ${altitude.toFixed(0)} degrees`}>
		<defs>
			<linearGradient id="arcfill" x1="0" x2="0" y1="0" y2="1">
				<stop offset="0" stopColor="var(--sky-a)" stopOpacity="0.35"/>
				<stop offset="1" stopColor="var(--sky-a)" stopOpacity="0"/>
			</linearGradient>
		</defs>
		<path d={`M ${cx - r} ${base} A ${r} ${base - 8} 0 0 1 ${cx + r} ${base}`} fill="url(#arcfill)" stroke="var(--line-strong)" strokeDasharray="3 4"/>
		<line x1="4" x2={W - 4} y1={base} y2={base} stroke="var(--line-strong)"/>
		<text x={cx - r} y={H - 1} textAnchor="middle">{tokyoClock(rise)}</text>
		<text x={cx + r} y={H - 1} textAnchor="middle">{tokyoClock(set)}</text>
		{up
			? <g transform={`translate(${sx} ${sy})`}><circle r="11" fill="var(--sun)" opacity="0.25"/><circle r="6" fill="var(--sun)"/></g>
			: <g transform={`translate(${cx} ${base + 1})`}><circle r="5" fill="none" stroke="var(--ink-2)" strokeWidth="1.5"/></g>}
		<text x={cx} y="12" textAnchor="middle" className={styles.arc__alt}>{`sun ${altitude.toFixed(0)}°`}</text>
	</svg>;
};

const RainBars: React.FC<{hours: WeatherHour[]}> = ({hours}) => {
	if (!hours.length) return null;
	return <div className={styles.bars}>
		{hours.map(h => <div key={h.time + h.desc} title={`${h.time} · ${h.desc} · ${h.rain}% rain`}>
			<i style={{height: `${Math.max(4, h.rain)}%`}} className={h.rain >= 50 ? styles.bars__wet : ''}/>
			<b>{h.tempC}°</b>
			<span>{h.time.slice(0, 2)}</span>
		</div>)}
		<small>rain chance · next 24 h</small>
	</div>;
};

// Where along the route you are in building shade (blue) versus direct sun (amber).
const ShadeStrip: React.FC<{shade: ShadeResult | null; length: number; busy: boolean}> = ({shade, length, busy}) => {
	const runs: {from: number; to: number; shaded: boolean}[] = [];
	if (shade && !shade.night) {
		for (const s of shade.samples) {
			const last = runs[runs.length - 1];
			if (last && last.shaded === s.shaded) last.to = s.d + 8;
			else runs.push({from: s.d, to: s.d + 8, shaded: s.shaded});
		}
	}
	return <div className={`${styles.strip} ${busy && !shade ? styles['strip--busy'] : ''}`}>
		<svg viewBox="0 0 100 10" preserveAspectRatio="none">
			{shade?.night && <rect x="0" y="0" width="100" height="10" fill={ROUTE_NIGHT}/>}
			{runs.map((r, i) => <rect key={i} x={r.from / length * 100} y="0" width={Math.max(0.3, (r.to - r.from) / length * 100)} height="10" fill={r.shaded ? ROUTE_SHADE : ROUTE_SUN}/>)}
		</svg>
		<div><span>start</span><span>{shade?.night ? 'sun is down' : 'shade ▮ sun ▮ along the route'}</span><span>arrive</span></div>
	</div>;
};

const GuideLayer: React.FC = () => {
	const actions = useContext(ActionsContext);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const modelCanvasRef = useRef<HTMLCanvasElement>(null);
	const fxCanvasRef = useRef<HTMLCanvasElement>(null);
	const avatarRef = useRef<HTMLDivElement>(null);
	const travellerRef = useRef<Traveller3D | null>(null);
	const movingRef = useRef<number>(0);
	const fxRef = useRef(new WeatherFX());
	const lookRef = useRef<WeatherLook>(PRESETS.clear);
	const precipRef = useRef<PrecipState>({kind: 'none', intensity: 0, windBearing: 0, windKmph: 0, night: false});
	const navRef = useRef<NavState | null>(null);
	const placesRef = useRef<Place[]>([]);
	const weatherFetchRef = useRef<{lat: number; lon: number; at: number} | null>(null);
	const mapTimeRef = useRef<number>(Date.now());

	const [mapTime, setMapTime] = useState<number>(Date.now());
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
	const [route, setRoute] = useState<{label: string; route: Route; key: string} | null>(null);
	const [shade, setShade] = useState<ShadeResult | null>(null);
	const [shadeBusy, setShadeBusy] = useState<boolean>(false);
	const [cmdOpen, setCmdOpen] = useState<boolean>(false);
	const [liveTick, setLiveTick] = useState<number>(0);
	const [skyOpen, setSkyOpen] = useState<boolean>(false);
	const [demo, setDemo] = useState<string>('live');
	const [openPin, setOpenPin] = useState<number | null>(null);
	// Where routes start: set by "Set as start", else the browser's location, else a sensible default.
	const originRef = useRef<{pos: LatLon; label: string} | null>(null);
	const [originLabel, setOriginLabel] = useState<string>('');
	const pinLayerRef = useRef<HTMLDivElement>(null);
	const [renderedSunAlt, setRenderedSunAlt] = useState<number | null>(null);

	// Follow the sun the map is actually rendering (time presets included).
	useEffect(() => {
		const timer = setInterval((): void => {
			const info = actions.getCameraInfo();
			if (info) setRenderedSunAlt(Math.round(info.sunAltitude * 2) / 2);
		}, 1000);
		return (): void => clearInterval(timer);
	}, [actions]);
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus/scrollIntoView can still scroll an overflow:hidden root; snap it back.
	useEffect(() => {
		const onScroll = (): void => {
			if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
		};
		window.addEventListener('scroll', onScroll);
		return (): void => window.removeEventListener('scroll', onScroll);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setCmdOpen(true);
				inputRef.current?.focus();
			}
		};
		window.addEventListener('keydown', onKey);
		return (): void => window.removeEventListener('keydown', onKey);
	}, []);

	const onMinute = useCallback((t: number): void => {
		mapTimeRef.current = t;
		setMapTime(t);
	}, []);

	// ---------- time of day ----------

	const cam = readCamera(actions);
	const here: LatLon = Number.isNaN(cam.lat) ? TOKYO : [cam.lat, cam.lon];
	const sunAltitude = renderedSunAlt ?? SunCalc.getPosition(new Date(mapTime), here[0], here[1]).altitude * 180 / Math.PI;
	const phase = phaseFor(sunAltitude);
	const shadowRatio = sunAltitude > 0.5 ? 1 / Math.tan(sunAltitude * Math.PI / 180) : null;

	// ---------- weather ----------

	const refreshWeather = useCallback(async (force: boolean = false): Promise<void> => {
		const c = readCamera(actions);
		if (Number.isNaN(c.lat)) return;
		const last = weatherFetchRef.current;
		const moved = last ? haversine([last.lat, last.lon], [c.lat, c.lon]) : Infinity;
		if (!force && last && moved < 3000 && Date.now() - last.at < 10 * 60e3) return;
		weatherFetchRef.current = {lat: c.lat, lon: c.lon, at: Date.now()};
		try {
			const r = await fetch(`/api/weather?lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}`);
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

	const look: WeatherLook = weatherMode === 'live'
		? (weather ? lookFromWeather(weather.now.code, weather.now.precipMM, weather.now.cloud, weather.now.windKmph) : PRESETS.clear)
		: PRESETS[weatherMode] ?? PRESETS.clear;
	const wet = look.kind === 'rain' || look.kind === 'storm';

	useEffect(() => {
		lookRef.current = look;
		const windIdx = COMPASS.indexOf(weather?.now.windDir ?? 'N');
		precipRef.current = {
			kind: wet ? 'rain' : look.kind === 'snow' ? 'snow' : 'none',
			intensity: look.intensity,
			windBearing: Math.max(0, windIdx) * 22.5,
			windKmph: look.windKmph,
			night: phase === 'night' || phase === 'twilight'
		};
		// Wet streets: turn on screen-space reflections so buildings mirror in the road.
		try {
			actions.setSettingStatus('ssr', wet ? 'low' : 'off');
		} catch (e) {
			// map not ready yet
		}
	}, [look.kind, look.intensity, look.windKmph, weather, phase, actions, wet]);

	// ---------- navigation ----------

	const showOverview = useCallback((): void => {
		const nav = navRef.current;
		if (!nav) return;
		// Past ~4 km streets-gl switches to its flat slippy map, which suits a whole-route overview.
		// Fit the whole route into the part of the screen not covered by panels (top-down, north up).
		const {center, extentNS, extentEW} = nav.path.bounds();
		const phone = window.innerWidth < 720;
		const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
		const usableH = phone ? 0.38 : 0.78;
		const usableW = phone ? 0.88 : Math.min(0.9, Math.max(0.45, (window.innerWidth - 720) / window.innerWidth));
		const tanHalf = Math.tan(20 * Math.PI / 180); // default 40° vertical FOV
		const pad = 1.4; // room for stop labels and the top controls
		const distance = Math.min(Math.max(
			(extentNS * pad) / (usableH * 2 * tanHalf),
			(extentEW * pad) / (usableW * aspect * 2 * tanHalf),
			500
		), 20000);
		// On phones the bottom sheet covers the lower ~60%: aim the camera south so the route sits above it.
		const visH = 2 * distance * tanHalf;
		const lat = phone ? center[0] - (0.5 - usableH / 2) * visH / 110574 : center[0];
		nav.phase = 'overview';
		nav.pendingCamera = [lat, center[1], 89.9, 0, distance];
		setNavPhase('overview');
	}, []);

	const startRoute = useCallback((raw: Route, label: string, from: LatLon, to: LatLon): void => {
		// Ride / walk on the left side of the road (Japan), crossing where the route turns right.
		// Walking routes already follow mapped pavements/footways, so only nudge them; bikes keep left in the road.
		const r = offsetRoute(raw, raw.mode === 'bike' ? 3 : 1.5, from, to);
		const path = new RoutePath(r);
		navRef.current = {path, label, from, to, traveled: 0, heading: path.headingAt(0), phase: 'overview', multiplier, pendingCamera: null, shade: null};
		setNavMode(r.mode);
		setRoute({label, route: r, key: `${from.join(',')}>${to.join(',')}:${r.mode}`});
		setShade(null);
		setHud(null);
		showOverview();
	}, [multiplier, showOverview]);

	const chooseOrigin = useCallback(async (to: LatLon): Promise<{pos: LatLon; label: string}> => {
		const far = (p: LatLon): boolean => haversine(p, to) > 150;
		if (originRef.current && far(originRef.current.pos) && haversine(originRef.current.pos, to) < 30000) return originRef.current;
		if (navigator.geolocation) {
			const here = await new Promise<LatLon | null>(resolve => {
				navigator.geolocation.getCurrentPosition(
					p => resolve([p.coords.latitude, p.coords.longitude]),
					() => resolve(null),
					{timeout: 3000, maximumAge: 300000}
				);
			});
			if (here && far(here) && haversine(here, to) < 30000) return {pos: here, label: 'Your location'};
		}
		const c = readCamera(actions);
		const cam: LatLon = [c.lat, c.lon];
		if (!Number.isNaN(c.lat) && far(cam) && haversine(cam, to) < 30000) return {pos: cam, label: 'Map centre'};
		// Looking right at the destination: start from a well-known point instead of a 0 m route.
		const station: LatLon = TOKYO;
		const tower: LatLon = [35.6586, 139.7454];
		return far(station) ? {pos: station, label: 'Tokyo Station'} : {pos: tower, label: 'Tokyo Tower'};
	}, [actions]);

	const routeTo = useCallback(async (to: LatLon, mode: 'walk' | 'bike', label: string, fromOverride?: LatLon): Promise<void> => {
		let from: LatLon;
		if (fromOverride) {
			from = fromOverride;
		} else {
			const o = await chooseOrigin(to);
			from = o.pos;
			setOriginLabel(o.label);
		}
		try {
			const r = await fetch(`/api/route?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}&mode=${mode}`);
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			startRoute(data as Route, label, from, to);
		} catch (e) {
			setMessages(m => [...m, {role: 'assistant', content: `Couldn't find a ${mode} route: ${(e as Error).message}`}]);
		}
	}, [chooseOrigin, startRoute]);

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
		setRoute(null);
		setShade(null);
		setHud(null);
	}, []);

	useEffect(() => {
		if (navRef.current) navRef.current.multiplier = multiplier;
	}, [multiplier]);

	// ↵ starts the planned route (when focus isn't in a text field)
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
			if (e.key === 'Enter' && !typing && navRef.current?.phase === 'overview') beginFollow();
		};
		window.addEventListener('keydown', onKey);
		return (): void => window.removeEventListener('keydown', onKey);
	}, [beginFollow]);

	// Shade along the route for the map's current hour (recomputed when the hour changes).
	const hourBucket = Math.floor(mapTime / 3600e3);
	useEffect(() => {
		if (!route) return undefined;
		let cancelled = false;
		setShadeBusy(true);
		const at = mapTimeRef.current;
		fetch('/api/shade', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({coords: route.route.coords, iso: new Date(at).toISOString(), duration_s: route.route.duration_s})
		})
			.then(r => r.json())
			.then(data => {
				if (cancelled || data.error) return;
				const result = {...data, at} as ShadeResult;
				setShade(result);
				if (navRef.current) navRef.current.shade = result;
			})
			.catch(e => console.warn('shade failed', e))
			.finally(() => !cancelled && setShadeBusy(false));
		return (): void => {
			cancelled = true;
		};
	}, [route?.key, hourBucket]);

	// ---------- 3D layer ----------

	useEffect(() => {
		if (!modelCanvasRef.current) return undefined;
		try {
			travellerRef.current = new Traveller3D(modelCanvasRef.current);
		} catch (e) {
			console.warn('3D layer unavailable, falling back to 2D', e);
		}
		return (): void => travellerRef.current?.dispose();
	}, []);

	// ---------- render loop: route line, pins, 3D traveller + precipitation, follow camera, sky FX ----------

	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		let hudTimer = 0;

		const drawFrame = (dt: number): void => {
			const canvas = canvasRef.current;
			const ctx = canvas?.getContext('2d');
			const fxCtx = fxCanvasRef.current?.getContext('2d');
			if (!ctx || !fxCtx) return;

			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const w = window.innerWidth;
			const h = window.innerHeight;

			for (const c of [ctx, fxCtx]) {
				if (c.canvas.width !== Math.round(w * dpr) || c.canvas.height !== Math.round(h * dpr)) {
					c.canvas.width = Math.round(w * dpr);
					c.canvas.height = Math.round(h * dpr);
				}
				c.setTransform(dpr, 0, 0, dpr, 0, 0);
				c.clearRect(0, 0, w, h);
			}

			const nav = navRef.current;
			let travellerState: Parameters<Traveller3D['render']>[1] = null;

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

				movingRef.current += ((nav.phase === 'follow' ? 1 : 0) - movingRef.current) * Math.min(1, dt * 4);
				travellerState = {lat: pos[0], lon: pos[1], heading: nav.heading, travelled: nav.traveled, moving: movingRef.current, mode: nav.path.route.mode};

				if (avatarRef.current) {
					const screen = travellerRef.current ? null : actions.projectLatLon(pos[0], pos[1]);
					avatarRef.current.style.display = screen ? 'block' : 'none';
					if (screen) avatarRef.current.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
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
						etaSeconds: nav.path.route.duration_s * remaining / Math.max(nav.path.length, 1),
						inShade: shadedAt(nav.shade, nav.traveled)
					});
				}
			} else if (avatarRef.current) {
				avatarRef.current.style.display = 'none';
			}

			const info = actions.getCameraInfo();
			if (travellerRef.current && info) {
				travellerRef.current.render(info, travellerState, precipRef.current, dt);
			}

			// Place pins are DOM buttons so they can be clicked; keep them glued to the map.
			const pinEls = pinLayerRef.current?.children;
			if (pinEls) {
				for (let i = 0; i < pinEls.length; i++) {
					const el = pinEls[i] as HTMLElement;
					const p = placesRef.current[Number(el.dataset.idx)];
					const sp = p ? actions.projectLatLon(p.lat, p.lon) : null;
					if (sp && sp[0] > -80 && sp[1] > -80 && sp[0] < w + 80 && sp[1] < h + 80) {
						el.style.display = 'block';
						el.style.transform = `translate(${sp[0]}px, ${sp[1]}px)`;
					} else {
						el.style.display = 'none';
					}
				}
			}
			fxRef.current.draw(fxCtx, dt, w, h, lookRef.current, !travellerRef.current);
		};

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

		raf = requestAnimationFrame(frame);
		return (): void => cancelAnimationFrame(raf);
	}, [actions]);

	useEffect(() => {
		placesRef.current = places;
	}, [places]);

	// ---------- AI agent ----------

	const applyActions = useCallback((list: AgentAction[]): void => {
		// A new route shows its own overview; don't let a camera move in the same reply override it.
		const routing = list.some(a => a.type === 'navigate');
		if (routing) setCmdOpen(false); // reveal the route overview
		for (const a of list) {
			if (a.type === 'fly_to') {
				if (routing) continue;
				if (navRef.current?.phase === 'follow') pause();
				actions.goToState(a.lat, a.lon, a.pitch ?? 50, a.yaw ?? readCamera(actions).yaw, a.distance ?? 600);
			} else if (a.type === 'set_time') {
				const t = Date.parse(a.iso);
				if (!Number.isNaN(t)) {
					setLiveTick(n => n + 1);
					actions.setTime(t);
				}
			} else if (a.type === 'show_places') {
				setPlaces(a.places ?? []);
			} else if (a.type === 'navigate' && a.route) {
				const c = a.route.coords;
				const last = a.route.waypoints?.[a.route.waypoints.length - 1];
				startRoute(a.route, a.label ?? 'Destination', c[0], last ? [last.lat, last.lon] : c[c.length - 1]);
			}
		}
	}, [actions, pause, startRoute]);

	// "Where I am": chosen start point, else the browser location (quick), else nothing (server uses the camera).
	const whereAmI = useCallback(async (): Promise<{lat: number; lon: number; label: string} | null> => {
		if (originRef.current) return {lat: originRef.current.pos[0], lon: originRef.current.pos[1], label: originRef.current.label};
		if (!navigator.geolocation) return null;
		return new Promise(resolve => {
			navigator.geolocation.getCurrentPosition(
				p => resolve({lat: p.coords.latitude, lon: p.coords.longitude, label: 'your location'}),
				() => resolve(null),
				{timeout: 2000, maximumAge: 300000}
			);
		});
	}, []);

	const send = useCallback(async (text: string): Promise<void> => {
		const content = text.trim();
		if (!content || busy) return;
		const history = [...messages, {role: 'user' as const, content}];
		setMessages(history);
		setInput('');
		setBusy(true);
		setCmdOpen(true);
		try {
			const r = await fetch('/api/agent', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({messages: history.map(m => ({role: m.role, content: m.content})), camera: readCamera(actions), me: await whereAmI()})
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			setMessages(m => [...m, {role: 'assistant', content: data.reply || '(done)', tools: (data.trace ?? []).map((t: {tool: string}) => t.tool)}]);
			applyActions(data.actions ?? []);
		} catch (e) {
			setMessages(m => [...m, {role: 'assistant', content: (e as Error).message}]);
		} finally {
			setBusy(false);
		}
	}, [actions, applyActions, busy, messages, whereAmI]);

	const runDemo = useCallback((d: Demo): void => {
		setDemo(d.id);
		setWeatherMode(d.weather);
		setLiveTick(n => n + 1);
		const day = new Date(mapTimeRef.current).toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'});
		const times = SunCalc.getTimes(new Date(`${day}T12:00:00+09:00`), TOKYO[0], TOKYO[1]);
		try {
			actions.setTime(d.at ? d.at(times, day) : Date.now());
		} catch (e) {
			// map not ready
		}
		if (d.ride) {
			setOriginLabel('Tokyo Tower');
			void routeTo([35.6812, 139.7671], 'bike', 'Tokyo Station', [35.6586, 139.7454]);
		}
	}, [actions, routeTo]);

	// "Go here" from other panels (e.g. the building selection panel)
	useEffect(() => {
		const onRoute = (e: Event): void => {
			const d = (e as CustomEvent<{lat: number; lon: number; name?: string; mode?: 'walk' | 'bike'}>).detail;
			if (d && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
				setOpenPin(null);
				void routeTo([d.lat, d.lon], d.mode === 'bike' ? 'bike' : 'walk', d.name || 'Selected place');
			}
		};
		const onOrigin = (e: Event): void => {
			const d = (e as CustomEvent<{lat: number; lon: number; name?: string}>).detail;
			if (d && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
				originRef.current = {pos: [d.lat, d.lon], label: d.name || 'Selected place'};
				setOriginLabel(originRef.current.label);
			}
		};
		window.addEventListener('guide:route', onRoute);
		window.addEventListener('guide:origin', onOrigin);
		return (): void => {
			window.removeEventListener('guide:route', onRoute);
			window.removeEventListener('guide:origin', onOrigin);
		};
	}, [routeTo]);

	// Console / fallback hook: guide.routeTo([35.6812, 139.7671], 'bike', 'Tokyo Station')
	useEffect(() => {
		(window as any).guide = {routeTo, send, setWeatherMode, beginFollow, showOverview, actions, nav: navRef};
	}, [routeTo, send, beginFollow, showOverview, actions]);

	// ---------- view ----------

	const riding = navPhase === 'follow' || navPhase === 'paused' || navPhase === 'arrived';
	const stopKeys = (e: React.KeyboardEvent): void => e.stopPropagation();
	const minutes = route ? Math.max(1, Math.round((hud && riding ? hud.etaSeconds : route.route.duration_s) / 60)) : 0;
	const via = route ? viaStreet(route.route) : '';
	const shadeLine = shadeBusy && !shade
		? 'Calculating shade from building heights and the sun…'
		: shade
			? (shade.night
				? `Sun is down at ${tokyoClock(shade.at)}. No direct sun on this route.`
				: `${shade.shadePct}% of this route is in building shade at ${tokyoClock(shade.at)}. Sun ${shade.sun.altitude.toFixed(0)}° from the ${COMPASS[Math.round(shade.sun.bearing / 22.5) % 16]}, ${shade.buildings} buildings checked.`)
			: '';

	return <div className={styles.guide} data-phase={phase} data-route={route && !riding ? '' : undefined} data-sky={skyOpen ? 'open' : 'closed'}>
		<MapClock onMinute={onMinute} forceLive={liveTick}/>
		<canvas ref={canvasRef} className={styles.overlay}/>
		<canvas ref={modelCanvasRef} className={`${styles.overlay} ${styles['overlay--model']}`}/>
		<canvas ref={fxCanvasRef} className={`${styles.overlay} ${styles['overlay--fx']}`}/>
		<div ref={avatarRef} className={styles.avatar} style={{display: 'none'}}>{navMode === 'bike' ? '🚴' : '🚶'}</div>

		<div ref={pinLayerRef} className={styles.pins}>
			{places.slice(0, 8).map((p, i) => <div key={`${p.name}${p.lat}`} data-idx={i} className={`${styles.pin} ${openPin === i ? styles['pin--open'] : ''}`} style={{display: 'none'}}>
				<button className={styles.pin__label} onClick={(): void => setOpenPin(openPin === i ? null : i)}>
					<i/>{p.name.length > 24 ? p.name.slice(0, 23) + '…' : p.name}
				</button>
				{openPin === i && <div className={styles.pin__card}>
					<b>{p.name}</b>
					{p.note && <small>{p.note}</small>}
					<div className={styles.pin__go}>
						<button onClick={(): void => {
							setOpenPin(null);
							void routeTo([p.lat, p.lon], 'walk', p.name);
						}}>Walk here</button>
						<button onClick={(): void => {
							setOpenPin(null);
							void routeTo([p.lat, p.lon], 'bike', p.name);
						}}>Bike here</button>
					</div>
				</div>}
			</div>)}
		</div>

		{/* Sky panel: sun arc, conditions, rain outlook */}
		<section className={styles.sky}>
			<header className={styles.sky__head} onClick={(): void => setSkyOpen(!skyOpen)}>
				<span className={styles.phaseTag}>{PHASE_LABEL[phase]}</span>
				<span className={styles.sky__mini}>{KIND_ICON[look.kind]} {weather ? `${weather.now.tempC}°` : ''}</span>
				<span>{weather?.area ?? 'Tokyo'} · {tokyoClock(mapTime)}</span>
			</header>
			<SunArc time={mapTime} at={here} altitude={sunAltitude}/>
			<div className={styles.sky__now}>
				<span className={styles.sky__temp}>{weather ? weather.now.tempC : '--'}°</span>
				<div>
					<b>{weatherMode === 'live' ? (weather?.now.desc ?? 'Loading weather…') : `Preview · ${weatherMode}`}</b>
					{weather && <small>Feels {weather.now.feelsC}° · {weather.now.humidity}% humidity · {weather.now.windKmph} km/h {weather.now.windDir}</small>}
				</div>
			</div>
			<RainBars hours={upcomingHours(weather, 8)}/>
			<div className={styles.sky__facts}>
				<div><span>Shadows</span><b>{shadowRatio ? `${shadowRatio.toFixed(1)}×` : 'none'}</b><small>of building height</small></div>
				<div><span>Sunset</span><b>{to24h(weather?.days[0]?.sunset)}</b><small>{weather?.days[0]?.sunrise ? `sunrise ${to24h(weather.days[0].sunrise)}` : ''}</small></div>
			</div>
			<div className={styles.sky__modes} role="group" aria-label="Weather preview">
				{['live', 'clear', 'rain', 'storm', 'snow', 'fog'].map(m => <button
					key={m}
					className={weatherMode === m ? styles.on : ''}
					onClick={(): void => {
						setWeatherMode(m);
						setDemo('');
					}}
					title={m === 'live' ? 'Live weather' : `Preview ${m}`}
				>{m === 'live' ? 'LIVE' : KIND_ICON[m as WeatherKind]}</button>)}
			</div>
		</section>

		{/* Route panel */}
		{route && !riding && <section className={styles.route}>
			<header className={styles.route__head}>
				<div>
					<small>{originLabel ? `From ${originLabel} to` : 'Route to'}</small>
					<b>{route.label}</b>
				</div>
				<button onClick={endRoute} aria-label="Close route">✕</button>
			</header>
			<div className={styles.route__modes}>
				<button className={navMode === 'walk' ? styles.on : ''} onClick={(): void => switchMode('walk')}>Walk</button>
				<button className={navMode === 'bike' ? styles.on : ''} onClick={(): void => switchMode('bike')}>Bike</button>
			</div>
			<div className={styles.route__time}>
				<strong>{minutes}</strong><span>min</span>
				<em>{formatDistance(route.route.distance_m)}{via ? ` · via ${via}` : ''}</em>
			</div>
			<ShadeStrip shade={shade} length={route.route.distance_m} busy={shadeBusy}/>
			<p className={styles.route__note}>{shadeLine}</p>
			<div className={styles.route__stats}>
				<div><b>{shade ? `${shade.shadePct}%` : '–'}</b><span>in shade</span></div>
				<div><b>{shade ? shade.sunMinutes : '–'}<small> min</small></b><span>direct sun</span></div>
				<div><b>{shade && !shade.night ? `${shade.sun.altitude.toFixed(0)}°` : '–'}</b><span>sun height</span></div>
			</div>
			<button className={styles.route__go} onClick={beginFollow}>Start {navMode === 'bike' ? 'riding' : 'walking'} <kbd>↵</kbd></button>
		</section>}

		{/* Ride HUD */}
		{riding && hud && route && <div className={styles.ride}>
			<div className={styles.ride__instruction}>
				<div className={styles.ride__maneuver}>{navPhase === 'arrived' ? '◎' : maneuverGlyph(hud.next)}</div>
				<div>
					<span>{navPhase === 'arrived' ? 'Arrived' : `In ${formatDistance(hud.inMetres)}`}</span>
					<strong>{navPhase === 'arrived' ? route.label : hud.next}</strong>
					<small>{route.label}{via ? ` · via ${via}` : ''}</small>
				</div>
				<button className={styles.ride__ghost} onClick={showOverview}>Route</button>
				<button className={styles.ride__ghost} onClick={endRoute}>End</button>
			</div>
			{hud.inShade !== null && <div className={styles.ride__status}>
				<i className={hud.inShade ? styles.shadeDot : styles.sunDot}/>
				{shade?.night ? 'Night riding · lights on' : hud.inShade ? 'In building shade' : 'In direct sun'}
				{shade && !shade.night && <small>· {shade.shadePct}% of route shaded</small>}
				{wet && <small>· wet road</small>}
			</div>}
			<div className={styles.ride__bar}>
				<div><span>Arrive</span><strong>{tokyoClock(mapTimeRef.current + hud.etaSeconds * 1000)}</strong></div>
				<div><span>Remaining</span><strong>{Math.max(0, Math.round(hud.etaSeconds / 60))}<small>min</small></strong></div>
				<div><span>Distance</span><strong>{(hud.remaining / 1000).toFixed(1)}<small>km</small></strong></div>
				<div className={styles.ride__controls}>
					{navPhase === 'follow'
						? <button onClick={pause}>❚❚</button>
						: <button className={styles.ride__go} onClick={beginFollow}>{navPhase === 'arrived' ? '↺' : '▶'}</button>}
					<select value={multiplier} onChange={(e): void => setMultiplier(Number(e.target.value))}>
						{MULTIPLIERS.map(x => <option key={x} value={x}>{x}×</option>)}
					</select>
				</div>
			</div>
		</div>}

		{/* Demo moments */}
		{!riding && <nav className={styles.demos} aria-label="Demo moments">
			{DEMOS.map(d => <button key={d.id} className={demo === d.id ? styles['demos--on'] : ''} onClick={(): void => runDemo(d)}>
				<i>{d.glyph}</i>{d.label}
			</button>)}
		</nav>}

		{/* Ask the map (ai&): command bar */}
		{!riding && <section className={`${styles.cmd} ${cmdOpen ? styles['cmd--open'] : ''}`}>
			<form className={styles.cmd__bar} onSubmit={(e): void => {
				e.preventDefault();
				void send(input);
			}}>
				<span className={styles.cmd__spark}>✦</span>
				<input
					ref={inputRef}
					value={input}
					placeholder="Ask the map · 行きたい場所は？"
					onFocus={(): void => setCmdOpen(true)}
					onChange={(e): void => setInput(e.target.value)}
					onKeyDown={(e): void => {
						e.stopPropagation();
						if (e.key === 'Escape') {
							setCmdOpen(false);
							inputRef.current?.blur();
						}
					}}
					onKeyUp={stopKeys}
				/>
				{busy ? <span className={styles.cmd__busy}/> : <kbd>⌘K</kbd>}
			</form>
			{cmdOpen && <div className={styles.cmd__panel}>
				{messages.length === 0 && <div className={styles.cmd__suggest}>
					<small>Try</small>
					{['Cycle me to Tokyo Station', 'Shadiest walk to a café near here', 'Show Tokyo Tower at sunset'].map(q =>
						<button key={q} onClick={(): void => void send(q)}>{q}</button>)}
				</div>}
				{messages.length > 0 && <div className={styles.cmd__log}>
					{messages.slice(-6).map((m, i) => <div key={i} className={m.role === 'user' ? styles.q : styles.a}>
						{m.content}
						{m.tools && m.tools.length > 0 && <small>{m.tools.map(t => TOOL_LABEL[t] ?? t).join(' → ')}</small>}
					</div>)}
					{busy && <div className={styles.a}><span className={styles.dots}>Working</span></div>}
				</div>}
				{places.length > 0 && <div className={styles.cmd__places}>
					{places.slice(0, 5).map(p => <div key={`${p.name}${p.lat}`}>
						<button onClick={(): void => actions.goToState(p.lat, p.lon, 50, readCamera(actions).yaw, 350)}>
							<b>{p.name}</b>{p.note && <small>{p.note}</small>}
						</button>
						<button onClick={(): void => void routeTo([p.lat, p.lon], 'walk', p.name)}>Walk</button>
						<button onClick={(): void => void routeTo([p.lat, p.lon], 'bike', p.name)}>Bike</button>
					</div>)}
				</div>}
				<footer><span>ai& · Japan-hosted inference</span><button onClick={(): void => setCmdOpen(false)}>Hide</button></footer>
			</div>}
		</section>}
	</div>;
};

function drawRoute(ctx: CanvasRenderingContext2D, actions: UIActions, nav: NavState): void {
	const {coords, cumulative} = nav.path;
	const colorAt = (d: number): string => {
		const s = shadedAt(nav.shade, d);
		if (nav.shade?.night) return ROUTE_NIGHT;
		if (s === null) return ROUTE_SHADE;
		return s ? ROUTE_SHADE : ROUTE_SUN;
	};

	// Project once per frame
	const screen = coords.map(c => actions.projectLatLon(c[0], c[1]));

	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';

	// Casing for the remaining route
	ctx.beginPath();
	let pen = false;
	for (let i = 0; i < coords.length; i++) {
		const p = screen[i];
		if (!p || cumulative[i] < nav.traveled - 1) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
		pen = true;
	}
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
	ctx.lineWidth = 11;
	ctx.stroke();

	// Travelled part
	ctx.beginPath();
	pen = false;
	for (let i = 0; i < coords.length && cumulative[i] <= nav.traveled + 1; i++) {
		const p = screen[i];
		if (!p) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
		pen = true;
	}
	ctx.strokeStyle = 'rgba(120, 128, 140, 0.6)';
	ctx.lineWidth = 6;
	ctx.stroke();

	// Remaining part, coloured by shade / sun per segment
	ctx.lineWidth = 7;
	for (let i = 1; i < coords.length; i++) {
		const a = screen[i - 1], b = screen[i];
		if (!a || !b || cumulative[i] < nav.traveled) continue;
		ctx.beginPath();
		ctx.moveTo(a[0], a[1]);
		ctx.lineTo(b[0], b[1]);
		ctx.strokeStyle = colorAt((cumulative[i - 1] + cumulative[i]) / 2);
		ctx.stroke();
	}

	// Checkpoints: a circle at every turn, placed exactly on the drawn line, so you can see it lines up.
	const nextIdx = nav.path.stepOffsets.findIndex(o => o > nav.traveled + 3);
	const pulse = 1 + 0.25 * Math.sin(performance.now() / 180);
	nav.path.stepOffsets.forEach((off, i) => {
		if (i === 0 || i === nav.path.stepOffsets.length - 1) return; // start/end drawn separately
		const at = nav.path.pointAt(off);
		const p = actions.projectLatLon(at[0], at[1]);
		if (!p) return;
		const passed = off <= nav.traveled + 3;
		const isNext = i === nextIdx;
		const r = isNext ? 8 : 6;
		if (isNext) {
			ctx.beginPath();
			ctx.arc(p[0], p[1], r * 1.9 * pulse, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(47, 123, 255, 0.18)';
			ctx.fill();
		}
		ctx.beginPath();
		ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
		ctx.fillStyle = passed ? 'rgba(150, 156, 166, 0.9)' : '#ffffff';
		ctx.fill();
		ctx.lineWidth = isNext ? 3.5 : 2.5;
		ctx.strokeStyle = passed ? 'rgba(90, 96, 106, 0.9)' : (isNext ? '#2f7bff' : colorAt(off));
		ctx.stroke();
	});

	// Multi-stop trips: numbered circles with names at each place you visit.
	const stops = nav.path.route.waypoints ?? [];
	ctx.font = '700 12px Inter, "Hiragino Kaku Gothic ProN", sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	stops.forEach((wp, i) => {
		const p = actions.projectLatLon(wp.lat, wp.lon);
		if (!p) return;
		const final = i === stops.length - 1;
		ctx.beginPath();
		ctx.arc(p[0], p[1], 22, 0, Math.PI * 2);
		ctx.fillStyle = final ? 'rgba(20, 22, 26, 0.18)' : 'rgba(47, 123, 255, 0.2)';
		ctx.fill();
		ctx.beginPath();
		ctx.arc(p[0], p[1], 12, 0, Math.PI * 2);
		ctx.fillStyle = final ? '#14161A' : '#2f7bff';
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
		ctx.fillStyle = '#ffffff';
		ctx.fillText(String(i + 1), p[0], p[1] + 0.5);
		const label = wp.label.length > 26 ? wp.label.slice(0, 25) + '…' : wp.label;
		const w = ctx.measureText(label).width + 16;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
		ctx.beginPath();
		ctx.roundRect(p[0] - w / 2, p[1] - 48, w, 22, 11);
		ctx.fill();
		ctx.fillStyle = '#14161A';
		ctx.fillText(label, p[0], p[1] - 37);
	});
	ctx.textBaseline = 'alphabetic';

	const start = screen[0];
	if (start) {
		ctx.beginPath();
		ctx.arc(start[0], start[1], 7, 0, Math.PI * 2);
		ctx.fillStyle = '#22c55e';
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
	}

	const end = screen[screen.length - 1];
	if (end) {
		ctx.fillStyle = '#14161A';
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.arc(end[0], end[1] - 16, 8, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(end[0], end[1]);
		ctx.lineTo(end[0], end[1] - 8);
		ctx.stroke();
	}
}

export default React.memo(GuideLayer);
