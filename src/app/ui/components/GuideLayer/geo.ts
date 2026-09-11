export type LatLon = [number, number];

export interface RouteStep {
	text: string;
	lat: number;
	lon: number;
	distance_m: number;
}

export interface Route {
	mode: 'walk' | 'bike';
	distance_m: number;
	duration_s: number;
	coords: LatLon[];
	steps: RouteStep[];
}

const R = 6371e3;
const rad = (d: number): number => d * Math.PI / 180;
const deg = (r: number): number => r * 180 / Math.PI;

export function haversine(a: LatLon, b: LatLon): number {
	const dLat = rad(b[0] - a[0]);
	const dLon = rad(b[1] - a[1]);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

// Compass bearing a -> b, degrees clockwise from north.
export function bearing(a: LatLon, b: LatLon): number {
	const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
	const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
	return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function lerpAngle(from: number, to: number, t: number): number {
	const diff = ((to - from + 540) % 360) - 180;
	return (from + diff * t + 360) % 360;
}

// Precomputed polyline for fast "where am I after d metres" lookups.
export class RoutePath {
	public readonly coords: LatLon[];
	public readonly cumulative: number[];
	public readonly length: number;
	public readonly stepOffsets: number[];

	public constructor(public readonly route: Route) {
		this.coords = route.coords;
		this.cumulative = [0];

		for (let i = 1; i < this.coords.length; i++) {
			this.cumulative.push(this.cumulative[i - 1] + haversine(this.coords[i - 1], this.coords[i]));
		}

		this.length = this.cumulative[this.cumulative.length - 1] || 0;
		this.stepOffsets = route.steps.map(step => this.offsetOfNearest([step.lat, step.lon]));
	}

	private offsetOfNearest(p: LatLon): number {
		let best = 0;
		let bestDist = Infinity;

		for (let i = 0; i < this.coords.length; i++) {
			const d = haversine(p, this.coords[i]);

			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}

		return this.cumulative[best];
	}

	public pointAt(distance: number): LatLon {
		const d = Math.min(Math.max(distance, 0), this.length);
		let lo = 0;
		let hi = this.cumulative.length - 1;

		while (lo < hi - 1) {
			const mid = (lo + hi) >> 1;

			if (this.cumulative[mid] <= d) {
				lo = mid;
			} else {
				hi = mid;
			}
		}

		const segment = this.cumulative[hi] - this.cumulative[lo] || 1;
		const t = (d - this.cumulative[lo]) / segment;
		const a = this.coords[lo];
		const b = this.coords[hi];

		return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
	}

	public headingAt(distance: number, lookahead: number = 30): number {
		const a = this.pointAt(distance);
		const b = this.pointAt(Math.min(distance + lookahead, this.length));

		if (haversine(a, b) < 0.5) {
			return bearing(this.pointAt(Math.max(distance - lookahead, 0)), a);
		}

		return bearing(a, b);
	}

	// Next maneuver ahead of the traveller.
	public nextStep(distance: number): {step: RouteStep; inMetres: number} | null {
		for (let i = 0; i < this.stepOffsets.length; i++) {
			if (this.stepOffsets[i] > distance + 3) {
				return {step: this.route.steps[i], inMetres: this.stepOffsets[i] - distance};
			}
		}

		return null;
	}

	public bounds(): {center: LatLon; extentMetres: number; extentNS: number; extentEW: number} {
		let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

		for (const [lat, lon] of this.coords) {
			minLat = Math.min(minLat, lat);
			maxLat = Math.max(maxLat, lat);
			minLon = Math.min(minLon, lon);
			maxLon = Math.max(maxLon, lon);
		}

		const center: LatLon = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
		const extentNS = haversine([minLat, center[1]], [maxLat, center[1]]);
		const extentEW = haversine([center[0], minLon], [center[0], maxLon]);

		return {center, extentMetres: Math.max(extentNS, extentEW), extentNS, extentEW};
	}
}

/**
 * Shift a route to the left side of the road (Japan keeps left). Corners use mitred joins, so a
 * right turn naturally crosses the road on the far side of the junction (like a two-stage right
 * turn), while left turns hug the kerb. Short connectors join the real start/end points, which
 * crosses the road when the destination is on the other side.
 */
export function offsetRoute(route: Route, metres: number, from?: LatLon, to?: LatLon): Route {
	const c = route.coords;
	if (c.length < 2 || metres <= 0) return route;

	const lat0 = c[0][0], lon0 = c[0][1];
	const kx = 111320 * Math.cos(rad(lat0)), ky = 110574;
	const toXY = (p: LatLon): [number, number] => [(p[1] - lon0) * kx, (p[0] - lat0) * ky];
	const toLL = (x: number, y: number): LatLon => [lat0 + y / ky, lon0 + x / kx];

	// Drop near-duplicate points so directions are stable
	const pts: [number, number][] = [];
	for (const p of c) {
		const q = toXY(p);
		const last = pts[pts.length - 1];
		if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.8) pts.push(q);
	}
	if (pts.length < 2) return route;

	const unit = (a: [number, number], b: [number, number]): [number, number] => {
		const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
		return [dx / l, dy / l];
	};
	const left = (d: [number, number]): [number, number] => [-d[1], d[0]];

	const out: LatLon[] = [];
	for (let i = 0; i < pts.length; i++) {
		const prev = i > 0 ? left(unit(pts[i - 1], pts[i])) : null;
		const next = i < pts.length - 1 ? left(unit(pts[i], pts[i + 1])) : null;
		let n: [number, number];
		if (!prev) n = next;
		else if (!next) n = prev;
		else {
			const m: [number, number] = [prev[0] + next[0], prev[1] + next[1]];
			const l = Math.hypot(m[0], m[1]);
			if (l < 1e-3) {
				n = prev; // U-turn
			} else {
				const cosHalf = (m[0] * prev[0] + m[1] * prev[1]) / l;
				const scale = Math.min(1 / Math.max(cosHalf, 0.34), 3);
				n = [m[0] / l * scale, m[1] / l * scale];
			}
		}
		out.push(toLL(pts[i][0] + n[0] * metres, pts[i][1] + n[1] * metres));
	}

	const near = (a: LatLon | undefined, b: LatLon): boolean => !!a && haversine(a, b) < 120;
	const coords: LatLon[] = [
		...(near(from, c[0]) ? [from] : [c[0]]),
		...out,
		...(near(to, c[c.length - 1]) ? [to] : [c[c.length - 1]])
	];
	return {...route, coords};
}

export function formatDistance(m: number): string {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

export function formatDuration(s: number): string {
	const min = Math.max(1, Math.round(s / 60));
	return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
