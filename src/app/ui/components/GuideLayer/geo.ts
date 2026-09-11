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

	public bounds(): {center: LatLon; extentMetres: number} {
		let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

		for (const [lat, lon] of this.coords) {
			minLat = Math.min(minLat, lat);
			maxLat = Math.max(maxLat, lat);
			minLon = Math.min(minLon, lon);
			maxLon = Math.max(maxLon, lon);
		}

		const center: LatLon = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
		const extentMetres = Math.max(haversine([minLat, center[1]], [maxLat, center[1]]), haversine([center[0], minLon], [center[0], maxLon]));

		return {center, extentMetres};
	}
}

export function formatDistance(m: number): string {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

export function formatDuration(s: number): string {
	const min = Math.max(1, Math.round(s / 60));
	return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
