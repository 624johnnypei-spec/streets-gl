import Vec2 from "~/lib/math/Vec2";
import MathUtils from "~/lib/math/MathUtils";
import Tile from "../objects/Tile";
import System from "../System";
import CursorStyleSystem from "./CursorStyleSystem";
import TileSystem from "./TileSystem";
import UISystem from "./UISystem";
import TileObjectsSystem from "./TileObjectsSystem";
import TileBuilding from "../world/TileBuilding";
import {ObjectIdRect} from "../render/passes/GBufferPass";

export default class PickingSystem extends System {
	private enablePicking: boolean = true;
	private static readonly PickRadiusFine: number = 28;
	private static readonly PickRadiusCoarse: number = 40;
	private hoveredObjectId: number = 0;
	private coarsePointer: boolean = window.matchMedia?.('(pointer: coarse)').matches ?? false;
	private selectedObjectId: number = 0;
	private pendingClickVersion: number = -1;
	private pendingClickFrames: number = 0;
	public pointerVersion: number = 0;
	private lastObjectIdRect: ObjectIdRect = null;
	private pointerDownPosition: Vec2 = new Vec2();
	public selectedTileBuilding: TileBuilding = null;
	public pointerPosition: Vec2 = new Vec2();

	public constructor() {
		super();

		const canvas = document.getElementById('canvas');

		canvas.addEventListener('pointerdown', e => {
			if (e.button !== 0) {
				return;
			}

			this.updatePointerPositionFromEvent(e, true);
		});

		canvas.addEventListener('pointermove', e => {
			this.updatePointerPositionFromEvent(e);
		});

		canvas.addEventListener('pointerup', e => {
			if (e.button !== 0) {
				return;
			}

			this.updatePointerPositionFromEvent(e);

			if (this.pointerDownPosition.x === this.pointerPosition.x && this.pointerDownPosition.y === this.pointerPosition.y) {
				// Resolve the click once the object-ID read for this exact position has landed (matters for taps,
				// which have no hover frames before them).
				this.pendingClickVersion = this.pointerVersion;
				this.pendingClickFrames = 0;
			}
		});

		canvas.addEventListener('mouseenter', e => {
			this.enablePicking = true;
		});

		canvas.addEventListener('mouseleave', e => {
			this.enablePicking = false;
		});
	}

	public postInit(): void {

	}

	private updatePointerPositionFromEvent(e: PointerEvent, updatePointerDown: boolean = false): void {
		if (e.pointerType) {
			this.coarsePointer = e.pointerType === 'touch' || e.pointerType === 'pen';
		}

		this.pointerVersion++;

		if (document.pointerLockElement !== null) {
			this.pointerPosition.x = Math.floor(window.innerWidth / 2);
			this.pointerPosition.y = Math.floor(window.innerHeight / 2);
		} else {
			this.pointerPosition.x = e.clientX;
			this.pointerPosition.y = e.clientY;
		}

		if (updatePointerDown) {
			this.pointerDownPosition.x = this.pointerPosition.x;
			this.pointerDownPosition.y = this.pointerPosition.y;
		}
	}

	// Hit radius in render-target pixels: forgiving for mice, bigger for fingers.
	public getPickRadius(pixelsPerCSSPixel: number): number {
		const cssRadius = this.coarsePointer ? PickingSystem.PickRadiusCoarse : PickingSystem.PickRadiusFine;
		return Math.round(cssRadius * (pixelsPerCSSPixel || 1));
	}

	// `buffer` holds object IDs for a square around the pointer. Pick the non-empty ID closest to the pointer
	// (an exact hit wins); on equal distance, prefer the ID covering more of the square.
	public readObjectId(buffer: Uint32Array, rect: ObjectIdRect): void {
		// A new rect object means a new read has landed; otherwise the previous result still stands.
		if (rect !== this.lastObjectIdRect) {
			this.lastObjectIdRect = rect;
			this.hoveredObjectId = PickingSystem.findNearestObjectId(buffer, rect);
		}

		this.updatePointer();

		if (this.pendingClickVersion >= 0 && rect.version >= this.pendingClickVersion) {
			this.resolvePendingClick();
		}
	}

	private resolvePendingClick(): void {
		this.pendingClickVersion = -1;
		this.onClick();
	}

	private static findNearestObjectId(buffer: Uint32Array, rect: ObjectIdRect): number {
		const {width, height, centerX, centerY} = rect;

		if (width === 0 || height === 0) {
			return 0;
		}

		const exact = buffer[centerY * width + centerX];

		if (exact !== 0) {
			return exact;
		}

		const counts: Map<number, number> = new Map();
		let bestDistance = Infinity;
		let bestIds: number[] = [];

		for (let y = 0; y < height; y++) {
			const dy = y - centerY;

			for (let x = 0; x < width; x++) {
				const id = buffer[y * width + x];

				if (id === 0) {
					continue;
				}

				counts.set(id, (counts.get(id) ?? 0) + 1);

				const dx = x - centerX;
				const distance = dx * dx + dy * dy;

				if (distance < bestDistance) {
					bestDistance = distance;
					bestIds = [id];
				} else if (distance === bestDistance && !bestIds.includes(id)) {
					bestIds.push(id);
				}
			}
		}

		// Circular hit area: ignore the corners of the square.
		const radius = Math.max(centerX, width - 1 - centerX, centerY, height - 1 - centerY);
		let picked = 0;

		if (bestDistance <= radius * radius) {
			for (const id of bestIds) {
				if (picked === 0 || counts.get(id) > counts.get(picked)) {
					picked = id;
				}
			}
		}

		return picked;
	}

	public clearHoveredObjectId(): void {
		this.hoveredObjectId = 0;
		this.lastObjectIdRect = null;
		this.updatePointer();

		if (this.pendingClickVersion >= 0) {
			this.resolvePendingClick();
		}
	}

	private updatePointer(): void {
		if (this.hoveredObjectId > 0 && this.enablePicking) {
			this.systemManager.getSystem(CursorStyleSystem).enablePointer();
		} else {
			this.systemManager.getSystem(CursorStyleSystem).disablePointer();
		}
	}

	private onClick(): void {
		if (this.hoveredObjectId === 0 || this.hoveredObjectId === this.selectedObjectId) {
			this.clearSelection();
			return;
		}

		if (this.hoveredObjectId !== 0) {
			this.selectedObjectId = this.hoveredObjectId;

			const selectedValue = this.selectedObjectId - 1;

			const localTileId = selectedValue >> 16;
			const tile = this.systemManager.getSystem(TileSystem).getTileByLocalId(localTileId);
			const localFeatureId = selectedValue & 0xffff;
			const packedFeatureId = tile.buildingLocalToPackedMap.get(localFeatureId);

			const [type, id] = Tile.unpackFeatureId(packedFeatureId);

			const tileObjectsSystem = this.systemManager.getSystem(TileObjectsSystem);
			this.selectedTileBuilding = tileObjectsSystem.getTileBuildingByPackedId(packedFeatureId);

			// Let the UI know where the building is right away (no network needed for "Go here").
			const center = PickingSystem.getBuildingCenter(tile, packedFeatureId);
			if (center) {
				window.dispatchEvent(new CustomEvent('building:picked', {detail: {type, id, ...center}}));
			}

			this.systemManager.getSystem(UISystem).setActiveFeature(type, id);
		}
	}

	private static getBuildingCenter(tile: Tile, packedFeatureId: number): {lat: number; lon: number} {
		const range = tile.buildingOffsetMap.get(packedFeatureId);
		const positions = tile.extrudedMesh?.getPositionBuffer();

		if (!range || !positions || range[1] <= 0) {
			return null;
		}

		const [start, size] = range;
		let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

		for (let i = start; i < start + size; i++) {
			const x = positions[i * 3];
			const z = positions[i * 3 + 2];
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z);
			maxZ = Math.max(maxZ, z);
		}

		if (!isFinite(minX) || !isFinite(minZ)) {
			return null;
		}

		return MathUtils.meters2degrees(
			tile.position.x + (minX + maxX) / 2,
			tile.position.z + (minZ + maxZ) / 2
		);
	}

	public clearSelection(): void {
		this.selectedObjectId = 0;
		this.selectedTileBuilding = null;
		this.systemManager.getSystem(UISystem).clearActiveFeature();
	}

	public update(deltaTime: number): void {
		// Safety net: never swallow a click if the object-ID read stalls (counted in frames, not ms,
		// so a throttled/background tab doesn't resolve it early with a stale hover).
		if (this.pendingClickVersion >= 0 && ++this.pendingClickFrames > 20) {
			this.resolvePendingClick();
		}
	}
}