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
	private walkPhase = 0;

	public constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, premultipliedAlpha: true});
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;

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

		this.holder.add(this.shadow, this.ring, this.walker.root, this.cyclist.root);
	}

	/**
	 * @param lat, lon   traveller position
	 * @param heading    compass bearing in degrees
	 * @param travelled  metres travelled along the route (drives gait / wheels)
	 * @param moving     0 idle .. 1 moving (blends the animation)
	 */
	public render(info: CameraInfo, lat: number, lon: number, heading: number, travelled: number, moving: number, mode: Mode): void {
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

		// Floating origin: world content is offset by the wrapper position.
		const p = MathUtils.degrees2meters(lat, lon);
		const camPos = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
		this.holder.position.set(p.x + info.originX, info.groundY, p.y + info.originZ);

		// Exaggerate size with distance so the character stays readable (Tesla-style).
		const dist = camPos.distanceTo(this.holder.position);
		this.holder.scale.setScalar(MathUtils.clamp(dist / 24, 3, 80));

		// streets-gl axes: +X = north, +Z = east. Model faces +X.
		this.holder.rotation.y = -heading * Math.PI / 180;

		this.walker.root.visible = mode === 'walk';
		this.cyclist.root.visible = mode === 'bike';

		if (mode === 'walk') {
			this.walkPhase = (travelled / 0.75) * Math.PI;
			this.walker.animate(this.walkPhase, moving);
		} else {
			this.cyclist.animate(travelled, moving);
		}

		const pulse = 1 + Math.sin(performance.now() / 300) * 0.06;
		this.ring.scale.setScalar(pulse);

		// Match the map's sun (sunDirection points from the sun to the ground).
		const [sx, sy, sz] = info.sunDirection;
		const day = info.sunIntensity > 0;
		this.sun.position.set(-sx * 50, -sy * 50, -sz * 50).add(this.holder.position);
		this.sun.target.position.copy(this.holder.position);
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
