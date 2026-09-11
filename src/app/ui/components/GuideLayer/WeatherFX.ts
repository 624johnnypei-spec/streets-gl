export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog';

export interface WeatherLook {
	kind: WeatherKind;
	intensity: number; // 0..1
	windKmph: number;
	cloud: number; // 0..100
}

// wttr.in / WorldWeatherOnline condition codes
const RAIN = new Set([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359]);
const SNOW = new Set([179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377]);
const STORM = new Set([200, 386, 389, 392, 395]);
const FOG = new Set([143, 248, 260]);

export function lookFromWeather(code: number, precipMM: number, cloud: number, windKmph: number): WeatherLook {
	const byPrecip = Math.min(1, 0.25 + precipMM / 4);

	if (STORM.has(code)) return {kind: 'storm', intensity: Math.max(0.8, byPrecip), windKmph, cloud};
	if (SNOW.has(code)) return {kind: 'snow', intensity: Math.max(0.4, byPrecip), windKmph, cloud};
	if (RAIN.has(code)) return {kind: 'rain', intensity: byPrecip, windKmph, cloud};
	if (FOG.has(code)) return {kind: 'fog', intensity: 0.7, windKmph, cloud};
	if (cloud > 70) return {kind: 'cloudy', intensity: cloud / 100, windKmph, cloud};

	return {kind: 'clear', intensity: 0, windKmph, cloud};
}

export const PRESETS: Record<string, WeatherLook> = {
	clear: {kind: 'clear', intensity: 0, windKmph: 5, cloud: 5},
	rain: {kind: 'rain', intensity: 0.7, windKmph: 15, cloud: 95},
	storm: {kind: 'storm', intensity: 1, windKmph: 35, cloud: 100},
	snow: {kind: 'snow', intensity: 0.7, windKmph: 8, cloud: 90},
	fog: {kind: 'fog', intensity: 0.8, windKmph: 3, cloud: 80}
};

interface Particle {
	x: number;
	y: number;
	speed: number;
	len: number;
	drift: number;
}

export default class WeatherFX {
	private particles: Particle[] = [];
	private flash = 0;
	private nextFlash = 3;
	private time = 0;

	private target(look: WeatherLook, w: number, h: number): number {
		const area = (w * h) / (1440 * 900);

		if (look.kind === 'rain' || look.kind === 'storm') return Math.round((250 + 900 * look.intensity) * area);
		if (look.kind === 'snow') return Math.round((120 + 380 * look.intensity) * area);

		return 0;
	}

	private spawn(look: WeatherLook, w: number, h: number, anywhere: boolean): Particle {
		const snow = look.kind === 'snow';

		return {
			x: Math.random() * (w + 200) - 100,
			y: anywhere ? Math.random() * h : -30 - Math.random() * 60,
			speed: snow ? 40 + Math.random() * 70 : 1100 + Math.random() * 700,
			len: snow ? 1.5 + Math.random() * 2.5 : 14 + Math.random() * 18,
			drift: Math.random() * Math.PI * 2
		};
	}

	public draw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number, look: WeatherLook): void {
		this.time += dt;

		// Sky tint for overcast / wet weather, haze for fog
		const gloom = look.kind === 'clear' ? 0 : Math.min(0.32, (look.cloud / 100) * 0.18 + (look.kind === 'storm' ? 0.14 : look.kind === 'rain' ? 0.06 : 0));

		if (gloom > 0) {
			ctx.fillStyle = `rgba(28, 36, 52, ${gloom})`;
			ctx.fillRect(0, 0, w, h);
		}

		if (look.kind === 'fog') {
			const g = ctx.createLinearGradient(0, 0, 0, h);
			g.addColorStop(0, `rgba(215, 222, 230, ${0.75 * look.intensity})`);
			g.addColorStop(0.45, `rgba(215, 222, 230, ${0.35 * look.intensity})`);
			g.addColorStop(1, `rgba(215, 222, 230, ${0.12 * look.intensity})`);
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, w, h);
		}

		const want = this.target(look, w, h);

		while (this.particles.length < want) this.particles.push(this.spawn(look, w, h, true));
		if (this.particles.length > want) this.particles.length = want;

		const windSlant = Math.min(0.45, look.windKmph / 80);
		const snow = look.kind === 'snow';

		ctx.lineCap = 'round';
		ctx.strokeStyle = look.kind === 'storm' ? 'rgba(200, 215, 235, 0.55)' : 'rgba(210, 225, 245, 0.45)';
		ctx.lineWidth = 1.2;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
		ctx.beginPath();

		for (let i = 0; i < this.particles.length; i++) {
			const p = this.particles[i];

			if (snow) {
				p.y += p.speed * dt;
				p.x += (Math.sin(this.time * 1.3 + p.drift) * 25 + windSlant * 60) * dt;
				ctx.moveTo(p.x + p.len, p.y);
				ctx.arc(p.x, p.y, p.len, 0, Math.PI * 2);
			} else {
				p.y += p.speed * dt;
				p.x += p.speed * windSlant * dt;
				ctx.moveTo(p.x, p.y);
				ctx.lineTo(p.x - p.len * windSlant, p.y - p.len);
			}

			if (p.y > h + 40 || p.x > w + 120) this.particles[i] = this.spawn(look, w, h, false);
		}

		if (snow) ctx.fill(); else ctx.stroke();

		// Lightning
		if (look.kind === 'storm') {
			this.nextFlash -= dt;

			if (this.nextFlash <= 0) {
				this.flash = 1;
				this.nextFlash = 3 + Math.random() * 6;
			}
		}

		if (this.flash > 0.01) {
			const flicker = this.flash > 0.6 && Math.random() < 0.5 ? 0.4 : 1;
			ctx.fillStyle = `rgba(235, 240, 255, ${0.55 * this.flash * flicker})`;
			ctx.fillRect(0, 0, w, h);
			this.flash *= Math.pow(0.02, dt);
		}
	}
}
