import {OverpassEndpoint} from "~/app/systems/TileLoadingSystem";

export default interface UIActions {
	updateRenderGraph: () => void;
	goToLatLon: (lat: number, lon: number) => void;
	goToState: (lat: number, lon: number, pitch: number, yaw: number, distance: number) => void;
	lookAtNorth: () => void;
	setTime: (time: number) => void;
	resetSettings: () => void;
	setOverpassEndpoints: (endpoints: OverpassEndpoint[]) => void;
	resetOverpassEndpoints: () => void;
	getControlsStateHash: () => string;
	// Screen position (CSS px) of a ground point, or null when it is behind the camera.
	projectLatLon: (lat: number, lon: number) => [number, number] | null;
	// Camera + lighting snapshot for overlay renderers that share the map's view (null until ready).
	getCameraInfo: () => CameraInfo | null;
	// Change a status-type graphics setting (e.g. 'ssr' -> 'low'), same as the settings panel.
	setSettingStatus: (key: string, status: string) => void;
}

export interface CameraInfo {
	projection: ArrayLike<number>;
	world: ArrayLike<number>;
	originX: number;
	originZ: number;
	groundY: number;
	sunDirection: [number, number, number];
	// Altitude of the sun the map is actually rendering (degrees; honours time-of-day presets).
	sunAltitude: number;
	sunIntensity: number;
	ambientIntensity: number;
}