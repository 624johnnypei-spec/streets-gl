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
}