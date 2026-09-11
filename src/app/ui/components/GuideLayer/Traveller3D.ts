import * as THREE from 'three';
import {CameraInfo} from "~/app/ui/UIActions";
import MathUtils from "~/lib/math/MathUtils";

// Procedural low-poly walker and cyclist rendered in a transparent three.js canvas that
// copies the streets-gl camera every frame, so the model sits on the real 3D street.

type Mode = 'walk' | 'bike';

const SKIN = 0xf1c7a0;
const JERSEY = 0x2f7bff;
const PANTS = 0x1d2433;
const SHOE = 0xffffff;
const HELMET = 0xffffff;
const FRAME = 0xff3b5c;
const TYRE = 0x16181d;

function mat(color: number, roughness: number = 0.6, metalness: number = 0.05): THREE.MeshStandardMaterial {
	return new THREE.MeshStandardMaterial({color, roughness, metalness});
}

function limb(length: number, radius: number, material: THREE.Material): {pivot: THREE.Group; mesh: THREE.Mesh} {
	// Pivot at the top, hanging down -Y, so rotating the pivot swings the limb.
	const pivot = new THREE.Group();
	const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length - radius * 2, 4, 8), material);
	mesh.position.y = -length / 2;
	mesh.castShadow = true;
	pivot.add(mesh);
	return {pivot, mesh};
}

interface Leg {
	hip: THREE.Group;
	knee: THREE.Group;
}

function makeLeg(side: number, thigh: number, shin: number): Leg {
	const hip = limb(thigh, 0.075, mat(PANTS)).pivot;
	const knee = limb(shin, 0.065, mat(PANTS)).pivot;
	knee.position.y = -thigh;
	const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.11), mat(SHOE, 0.4));
	shoe.position.set(0.06, -shin - 0.02, 0);
	knee.add(shoe);
	hip.add(knee);
	hip.position.z = side * 0.1;
	return {hip, knee};
}

function makeArm(side: number): {shoulder: THREE.Group; elbow: THREE.Group} {
	const shoulder = limb(0.3, 0.055, mat(JERSEY)).pivot;
	const elbow = limb(0.28, 0.05, mat(SKIN)).pivot;
	elbow.position.y = -0.3;
	shoulder.add(elbow);
	shoulder.position.set(0, 1.42, side * 0.22);
	return {shoulder, elbow};
}

function makeTorso(): THREE.Group {
	const g = new THREE.Group();
	const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), mat(JERSEY, 0.5));
	body.position.y = 1.2;
	body.castShadow = true;
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), mat(SKIN));
	head.position.y = 1.66;
	head.castShadow = true;
	const cap = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(HELMET, 0.3));
	cap.position.y = 1.68;
	g.add(body, head, cap);
	return g;
}

class Walker {
	public readonly root = new THREE.Group();
	private readonly torso = makeTorso();
	private readonly legs = [makeLeg(1, 0.46, 0.44), makeLeg(-1, 0.46, 0.44)];
	private readonly arms = [makeArm(1), makeArm(-1)];

	public constructor() {
		const pelvis = new THREE.Group();
		pelvis.position.y = 0.92;
		for (const leg of this.legs) pelvis.add(leg.hip);
		this.root.add(pelvis, this.torso);
		for (const arm of this.arms) this.root.add(arm.shoulder);
	}

	public animate(phase: number, moving: number): void {
		// phase advances one full cycle per two steps
		this.legs.forEach((leg, i) => {
			const s = Math.sin(phase + i * Math.PI);
			leg.hip.rotation.z = s * 0.55 * moving;
			leg.knee.rotation.z = -Math.max(0, -Math.cos(phase + i * Math.PI)) * 0.9 * moving;
		});
		this.arms.forEach((arm, i) => {
			arm.shoulder.rotation.z = -Math.sin(phase + i * Math.PI) * 0.5 * moving;
			arm.elbow.rotation.z = 0.35 + 0.2 * moving;
		});
		this.root.position.y = Math.abs(Math.sin(phase)) * 0.05 * moving;
		this.torso.rotation.z = -0.06 * moving;
	}
}

class Cyclist {
	public readonly root = new THREE.Group();
	private readonly wheels: THREE.Group[] = [];
	private readonly crank = new THREE.Group();
	private readonly legs = [makeLeg(1, 0.44, 0.44), makeLeg(-1, 0.44, 0.44)];
	private readonly rider = new THREE.Group();

	private static readonly WHEEL_R = 0.34;
	private static readonly HIP = new THREE.Vector3(-0.18, 1.0, 0);
	private static readonly CRANK = new THREE.Vector3(0.02, 0.36, 0);
	private static readonly CRANK_LEN = 0.17;

	public constructor() {
		const frameMat = mat(FRAME, 0.35, 0.3);
		const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number = 0.028): THREE.Mesh => {
			const len = a.distanceTo(b);
			const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), frameMat);
			m.position.copy(a).add(b).multiplyScalar(0.5);
			m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
			m.castShadow = true;
			return m;
		};

		const R = Cyclist.WHEEL_R;
		const rear = new THREE.Vector3(-0.52, R, 0);
		const front = new THREE.Vector3(0.52, R, 0);
		const seat = new THREE.Vector3(-0.18, 0.92, 0);
		const head = new THREE.Vector3(0.36, 0.98, 0);
		const bb = Cyclist.CRANK.clone();

		for (const pos of [rear, front]) {
			const w = new THREE.Group();
			w.position.copy(pos);
			const tyre = new THREE.Mesh(new THREE.TorusGeometry(R, 0.035, 8, 28), mat(TYRE, 0.9));
			const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), mat(0xcccccc, 0.3, 0.6));
			hub.rotation.x = Math.PI / 2;
			w.add(tyre, hub);
			for (let i = 0; i < 6; i++) {
				const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.01, R * 2, 0.01), mat(0xdddddd, 0.3, 0.6));
				spoke.rotation.z = i * Math.PI / 6;
				w.add(spoke);
			}
			this.wheels.push(w);
			this.root.add(w);
		}

		this.root.add(
			tube(rear, bb), tube(bb, seat), tube(seat, rear), tube(seat, head), tube(bb, head, 0.032),
			tube(head, front, 0.022), tube(head, head.clone().add(new THREE.Vector3(-0.05, 0.12, 0)), 0.022)
		);

		const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8), mat(0x222222, 0.4));
		bars.rotation.x = Math.PI / 2;
		bars.position.set(0.31, 1.1, 0);
		const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.12), mat(0x111111, 0.7));
		saddle.position.set(-0.2, 0.96, 0);
		this.root.add(bars, saddle);

		this.crank.position.copy(bb);
		const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 6, 20), mat(0x999999, 0.3, 0.8));
		this.crank.add(ring);
		this.root.add(this.crank);

		// Rider: pelvis on the saddle, torso leaning toward the bars
		const torso = makeTorso();
		torso.position.y = -0.8; // torso group is modelled standing; drop its pelvis to the rider origin
		this.rider.add(torso);
		for (const side of [1, -1]) {
			const arm = limb(0.5, 0.05, mat(JERSEY)).pivot;
			arm.position.set(0, 0.62, side * 0.2);
			arm.rotation.z = 0.93;
			this.rider.add(arm);
		}
		this.rider.position.set(Cyclist.HIP.x, Cyclist.HIP.y, 0);
		this.rider.rotation.z = -0.55;
		this.root.add(this.rider);

		for (const leg of this.legs) {
			leg.hip.position.x = Cyclist.HIP.x;
			leg.hip.position.y = Cyclist.HIP.y;
			this.root.add(leg.hip);
		}
	}

	public animate(distance: number, moving: number): void {
		const R = Cyclist.WHEEL_R;
		for (const w of this.wheels) w.rotation.z = -distance / R;

		// ~2.2 m travelled per crank turn
		const crankAngle = -(distance / 2.2) * Math.PI * 2;
		this.crank.rotation.z = crankAngle;

		// Two-bone IK: put each foot on its pedal
		this.legs.forEach((leg, i) => {
			const a = crankAngle + i * Math.PI;
			const pedal = new THREE.Vector2(
				Cyclist.CRANK.x + Math.cos(a) * Cyclist.CRANK_LEN,
				Cyclist.CRANK.y + Math.sin(a) * Cyclist.CRANK_LEN
			);
			const hip = new THREE.Vector2(Cyclist.HIP.x, Cyclist.HIP.y);
			const d = Math.min(pedal.distanceTo(hip), 0.87);
			const l1 = 0.44, l2 = 0.44;
			const toPedal = Math.atan2(pedal.y - hip.y, pedal.x - hip.x);
			const bend = Math.acos(MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
			// Limbs hang along -Y, so subtract the rest angle (-PI/2)
			leg.hip.rotation.z = toPedal + bend + Math.PI / 2;
			const knee = Math.acos(MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
			leg.knee.rotation.z = -(Math.PI - knee);
		});

		this.rider.position.y = Cyclist.HIP.y + Math.sin(crankAngle * 2) * 0.012 * moving;
	}
}


// World-anchored precipitation volume: drops stay fixed in the world and wrap around the
// view, so moving the camera parallaxes through them (reads as real 3D rain).
const PRECIP_VERT = `
	attribute vec3 seed;
	attribute float tip;
	uniform float uTime;
	uniform vec3 uBox;
	uniform vec3 uCenter;
	uniform vec2 uAnchor;
	uniform float uFall;
	uniform float uLen;
	uniform vec2 uWind;
	uniform float uSnow;
	varying float vTip;
	varying float vFade;
	void main() {
		vec2 w = seed.xz * uBox.xz;
		vec2 xz = mod(w - uAnchor, uBox.xz) - 0.5 * uBox.xz;
		float y = mod(seed.y * uBox.y - uTime * uFall * (0.8 + 0.4 * fract(seed.x * 91.7)), uBox.y);
		vec3 p = vec3(uCenter.x + xz.x, uCenter.y + y, uCenter.z + xz.y);
		float sway = uSnow * sin(uTime * 1.3 + seed.x * 40.0) * uLen * 2.0;
		p.xz += uWind * (y / max(uFall, 0.001)) * 0.35 + vec2(sway, 0.0);
		vec3 dir = normalize(vec3(uWind.x, -uFall, uWind.y));
		p -= dir * uLen * tip * (1.0 - uSnow);
		vTip = tip;
		vFade = smoothstep(0.0, 0.15, y / uBox.y) * (1.0 - smoothstep(0.85, 1.0, y / uBox.y));
		vec4 mv = modelViewMatrix * vec4(p, 1.0);
		gl_Position = projectionMatrix * mv;
		gl_PointSize = uSnow * clamp(uLen * 900.0 / -mv.z, 1.5, 9.0);
	}
`;

const PRECIP_FRAG = `
	uniform vec3 uColor;
	uniform float uOpacity;
	uniform float uSnow;
	varying float vTip;
	varying float vFade;
	void main() {
		float a = uOpacity * vFade;
		if (uSnow > 0.5) {
			vec2 c = gl_PointCoord - 0.5;
			a *= smoothstep(0.5, 0.2, length(c));
		} else {
			a *= mix(1.0, 0.15, vTip);
		}
		gl_FragColor = vec4(uColor, a);
	}
`;

export interface PrecipState {
	kind: 'none' | 'rain' | 'snow';
	intensity: number; // 0..1
	windBearing: number; // compass degrees the wind blows FROM
	windKmph: number;
	night: boolean;
}

class Precipitation {
	public readonly lines: THREE.LineSegments;
	public readonly points: THREE.Points;
	private readonly lineMat: THREE.ShaderMaterial;
	private readonly pointMat: THREE.ShaderMaterial;
	private readonly count: number;

	public constructor(count: number = 22000) {
		this.count = count;
		const seeds = new Float32Array(count * 2 * 3);
		const tips = new Float32Array(count * 2);
		for (let i = 0; i < count; i++) {
			const sx = Math.random(), sy = Math.random(), sz = Math.random();
			for (let v = 0; v < 2; v++) {
				seeds.set([sx, sy, sz], (i * 2 + v) * 3);
				tips[i * 2 + v] = v;
			}
		}
		const lineGeo = new THREE.BufferGeometry();
		lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
		lineGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
		lineGeo.setAttribute('tip', new THREE.BufferAttribute(tips, 1));

		const pointGeo = new THREE.BufferGeometry();
		const pSeeds = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) pSeeds.set([Math.random(), Math.random(), Math.random()], i * 3);
		pointGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
		pointGeo.setAttribute('seed', new THREE.BufferAttribute(pSeeds, 3));
		pointGeo.setAttribute('tip', new THREE.BufferAttribute(new Float32Array(count), 1));

		const uniforms = (): Record<string, THREE.IUniform> => ({
			uTime: {value: 0}, uBox: {value: new THREE.Vector3(1, 1, 1)}, uCenter: {value: new THREE.Vector3()},
			uAnchor: {value: new THREE.Vector2()}, uFall: {value: 20}, uLen: {value: 3}, uWind: {value: new THREE.Vector2()},
			uColor: {value: new THREE.Color(0xdfe8f5)}, uOpacity: {value: 0.5}, uSnow: {value: 0}
		});
		const common = {vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG, transparent: true, depthWrite: false};
		this.lineMat = new THREE.ShaderMaterial({...common, uniforms: uniforms()});
		this.pointMat = new THREE.ShaderMaterial({...common, uniforms: uniforms()});
		this.pointMat.uniforms.uSnow.value = 1;

		this.lines = new THREE.LineSegments(lineGeo, this.lineMat);
		this.points = new THREE.Points(pointGeo, this.pointMat);
		this.lines.frustumCulled = false;
		this.points.frustumCulled = false;
	}

	public update(state: PrecipState, time: number, center: THREE.Vector3, anchor: THREE.Vector2, viewDistance: number): void {
		const rain = state.kind === 'rain';
		const snow = state.kind === 'snow';
		this.lines.visible = rain && state.intensity > 0;
		this.points.visible = snow && state.intensity > 0;
		if (!rain && !snow) return;

		const D = MathUtils.clamp(viewDistance, 60, 2500);
		const box = new THREE.Vector3(D * 1.6, D * 1.0, D * 1.6);
		// Wind blows FROM windBearing; streaks lean downwind. +X = north, +Z = east.
		const toward = (state.windBearing + 180) * Math.PI / 180;
		const windMs = state.windKmph / 3.6 * (D / 90);
		const wind = new THREE.Vector2(Math.cos(toward) * windMs, Math.sin(toward) * windMs);

		const mat = rain ? this.lineMat : this.pointMat;
		const u = mat.uniforms;
		u.uTime.value = time;
		u.uBox.value.copy(box);
		u.uCenter.value.copy(center);
		u.uAnchor.value.set(anchor.x % box.x, anchor.y % box.z);
		u.uFall.value = rain ? D / 9 : D / 70;
		u.uLen.value = rain ? D / 40 : D / 900;
		u.uWind.value.copy(wind);
		u.uOpacity.value = (rain ? 0.62 : 0.9) * (state.night ? 0.75 : 1);
		(u.uColor.value as THREE.Color).set(state.night ? 0x9fb3cc : 0xe4ecf7);

		const drawn = Math.round(this.count * MathUtils.clamp(0.25 + state.intensity * 0.75, 0, 1));
		if (rain) this.lines.geometry.setDrawRange(0, drawn * 2);
		else this.points.geometry.setDrawRange(0, drawn);
	}
}

export default class Traveller3D {
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera();
	private readonly sun = new THREE.DirectionalLight(0xffffff, 2.5);
	private readonly ambient = new THREE.HemisphereLight(0xdfe9ff, 0x4a4238, 0.9);
	private readonly holder = new THREE.Group();
	private readonly walker = new Walker();
	private readonly cyclist = new Cyclist();
	private readonly ring: THREE.Mesh;
	private readonly shadow: THREE.Mesh;
	private readonly shadowCatcher: THREE.Mesh;
	private readonly precip = new Precipitation();
	private walkPhase = 0;
	private clock = 0;

	public constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, premultipliedAlpha: true});
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

		// The traveller casts a real shadow along the map's sun direction.
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(1024, 1024);
		this.sun.shadow.bias = -0.0005;

		this.camera.matrixAutoUpdate = false;
		this.scene.add(this.ambient, this.sun, this.sun.target, this.holder);

		this.ring = new THREE.Mesh(
			new THREE.RingGeometry(0.75, 1.0, 40),
			new THREE.MeshBasicMaterial({color: JERSEY, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false})
		);
		this.ring.rotation.x = -Math.PI / 2;
		this.ring.position.y = 0.03;

		this.shadow = new THREE.Mesh(
			new THREE.CircleGeometry(0.7, 32),
			new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false})
		);
		this.shadow.rotation.x = -Math.PI / 2;
		this.shadow.position.y = 0.02;

		this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({opacity: 0.38, depthWrite: false}));
		this.shadowCatcher.rotation.x = -Math.PI / 2;
		this.shadowCatcher.position.y = 0.01;
		this.shadowCatcher.receiveShadow = true;

		this.holder.add(this.shadowCatcher, this.shadow, this.ring, this.walker.root, this.cyclist.root);
		this.walker.root.traverse(o => { o.castShadow = true; });
		this.cyclist.root.traverse(o => { o.castShadow = true; });
		this.scene.add(this.precip.lines, this.precip.points);
	}

	/**
	 * Render one frame sharing the map camera. `traveller` is null when no route is active.
	 * heading: compass bearing in degrees; travelled drives gait / wheels; moving blends 0 idle .. 1 moving.
	 */
	public render(
		info: CameraInfo,
		traveller: {lat: number; lon: number; heading: number; travelled: number; moving: number; mode: Mode} | null,
		precip: PrecipState,
		dt: number
	): void {
		this.clock += dt;
		const w = window.innerWidth;
		const h = window.innerHeight;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);

		if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr);
		const size = this.renderer.getSize(new THREE.Vector2());
		if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);

		// Share the map camera exactly (both are column-major OpenGL matrices).
		this.camera.projectionMatrix.fromArray(Array.from(info.projection));
		this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
		this.camera.matrix.fromArray(Array.from(info.world));
		this.camera.matrixWorld.copy(this.camera.matrix);
		this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

		const camPos = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
		const [sx, sy, sz] = info.sunDirection;
		const day = info.sunIntensity > 0;

		// Precipitation volume centred between the camera and the ground it looks at.
		const viewDir = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld);
		const toGround = viewDir.y < -0.05 ? (camPos.y - info.groundY) / -viewDir.y : 400;
		const target = camPos.clone().addScaledVector(viewDir, toGround);
		const center = camPos.clone().lerp(target, 0.55);
		center.y = info.groundY;
		// Absolute (mercator) position of the centre, for world-anchored wrapping.
		const anchor = new THREE.Vector2(center.x - info.originX, center.z - info.originZ);
		this.precip.update(precip, this.clock, center, anchor, camPos.distanceTo(target));

		this.holder.visible = !!traveller;

		if (traveller) {
			// Floating origin: world content is offset by the wrapper position.
			const p = MathUtils.degrees2meters(traveller.lat, traveller.lon);
			this.holder.position.set(p.x + info.originX, info.groundY, p.y + info.originZ);

			// Exaggerate size with distance so the character stays readable (Tesla-style).
			const dist = camPos.distanceTo(this.holder.position);
			this.holder.scale.setScalar(MathUtils.clamp(dist / 24, 3, 80));

			// streets-gl axes: +X = north, +Z = east. Model faces +X.
			this.holder.rotation.y = -traveller.heading * Math.PI / 180;

			this.walker.root.visible = traveller.mode === 'walk';
			this.cyclist.root.visible = traveller.mode === 'bike';

			if (traveller.mode === 'walk') {
				this.walkPhase = (traveller.travelled / 0.75) * Math.PI;
				this.walker.animate(this.walkPhase, traveller.moving);
			} else {
				this.cyclist.animate(traveller.travelled, traveller.moving);
			}

			this.ring.scale.setScalar(1 + Math.sin(this.clock * 3.3) * 0.06);

			// Match the map's sun (sunDirection points from the sun to the ground).
			const s = this.holder.scale.x;
			this.sun.position.set(-sx * 30 * s, -sy * 30 * s, -sz * 30 * s).add(this.holder.position);
			this.sun.target.position.copy(this.holder.position);
			const cam = this.sun.shadow.camera;
			cam.left = cam.bottom = -4 * s;
			cam.right = cam.top = 4 * s;
			cam.near = 1;
			cam.far = 80 * s;
			cam.updateProjectionMatrix();
			this.shadowCatcher.visible = day;
			(this.shadow.material as THREE.MeshBasicMaterial).opacity = day ? 0.12 : 0.28;
		}

		this.sun.intensity = day ? 2.6 : 0.4;
		this.ambient.intensity = day ? 1.0 : 0.55;

		this.renderer.render(this.scene, this.camera);
	}

	public clear(): void {
		this.renderer.clear();
	}

	public dispose(): void {
		this.renderer.dispose();
	}
}
