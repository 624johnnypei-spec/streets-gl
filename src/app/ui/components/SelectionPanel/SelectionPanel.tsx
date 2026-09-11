import React, {useCallback, useContext, useEffect, useState} from "react";
import {useRecoilState} from "recoil";
import styles from "./SelectionPanel.scss";
import Panel from "~/app/ui/components/Panel";
import {AtomsContext} from "~/app/ui/UI";
import Skeleton, {SkeletonTheme} from "react-loading-skeleton";
import 'react-loading-skeleton/dist/skeleton.css';
import buildingTypes from "~/app/ui/components/SelectionPanel/buildingTypes";
import ModalButton from "~/app/ui/components/ModalButton";
import PanelCloseButton from "~/app/ui/components/PanelCloseButton";
import {MdDirectionsBike, MdDirectionsWalk} from "react-icons/md";

type OSMType = 'way' | 'relation';
type GoMode = 'walk' | 'bike';

interface LatLon {
	lat: number;
	lon: number;
}

interface FeatureDetails {
	tags: Record<string, string>;
	center: LatLon | null;
}

interface SelectedFeature {
	type: OSMType;
	id: number;
	key: string;
}

interface OSMElement {
	type: string;
	id: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
}

// Client-side caches keyed by "type/id": details from the network, and centres derived locally from the tile mesh.
const detailsCache: Map<string, FeatureDetails> = new Map();
const detailsInflight: Map<string, Promise<FeatureDetails>> = new Map();
const localCenters: Map<string, LatLon> = new Map();

const toOSMType = (type: number): OSMType => type === 0 ? 'way' : 'relation';
const featureKey = (type: OSMType, id: number): string => `${type}/${id}`;

const isLatLon = (value: LatLon | null | undefined): value is LatLon => {
	return !!value && Number.isFinite(value.lat) && Number.isFinite(value.lon);
};

const getOSMURL = (type: OSMType, id: number): string => {
	return `https://api.openstreetmap.org/api/0.6/${type}/${id}/full.json`;
};

const parseOSMResponse = (type: OSMType, id: number, elements: OSMElement[]): FeatureDetails => {
	const self = elements.find(e => e.type === type && e.id === id);

	if (!self) {
		throw new Error(`${type} ${id} not found`);
	}

	let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

	for (const e of elements) {
		if (e.type !== 'node' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) {
			continue;
		}

		minLat = Math.min(minLat, e.lat);
		maxLat = Math.max(maxLat, e.lat);
		minLon = Math.min(minLon, e.lon);
		maxLon = Math.max(maxLon, e.lon);
	}

	const center = Number.isFinite(minLat) ? {lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2} : null;

	return {tags: self.tags ?? {}, center};
};

const fetchFromProxy = async (type: OSMType, id: number): Promise<FeatureDetails> => {
	const response = await fetch(`/api/osm/${type}/${id}`);

	if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('json')) {
		throw new Error(`/api/osm -> HTTP ${response.status}`);
	}

	const data = await response.json() as FeatureDetails;

	if (!data || typeof data.tags !== 'object') {
		throw new Error('/api/osm returned an unexpected payload');
	}

	return {tags: data.tags ?? {}, center: isLatLon(data.center) ? data.center : null};
};

const fetchFromOSM = async (type: OSMType, id: number): Promise<FeatureDetails> => {
	const response = await fetch(getOSMURL(type, id));

	if (!response.ok) {
		throw new Error(`OSM API -> HTTP ${response.status}`);
	}

	const osm = await response.json() as {elements?: OSMElement[]};

	return parseOSMResponse(type, id, osm.elements ?? []);
};

const loadDetails = (type: OSMType, id: number): Promise<FeatureDetails> => {
	const key = featureKey(type, id);
	const hit = detailsCache.get(key);

	if (hit) {
		return Promise.resolve(hit);
	}

	const pending = detailsInflight.get(key);

	if (pending) {
		return pending;
	}

	const request = fetchFromProxy(type, id)
		.catch(() => fetchFromOSM(type, id))
		.then(details => {
			detailsCache.set(key, details);
			return details;
		})
		.finally(() => {
			detailsInflight.delete(key);
		});

	detailsInflight.set(key, request);

	return request;
};

// PickingSystem fires this synchronously on click, before the selection reaches React:
// cache the locally derived centre and start the details request as early as possible.
// Tokyo PLATEAU attributes (use, height, floors, address, landmark names), looked up by position on our server.
interface PlateauInfo {
	name?: string;
	usage?: string;
	usage_ja?: string;
	height_m?: number;
	storeys?: number;
	address?: string;
}
const placeNameCache = new Map<string, {name: string; name_en?: string | null} | null>();
const plateauCache = new Map<string, PlateauInfo | null>();

window.addEventListener('building:picked', (e: Event): void => {
	const detail = (e as CustomEvent<{type: number; id: number; lat: number; lon: number}>).detail;

	if (!detail || !Number.isFinite(detail.id)) {
		return;
	}

	const type = toOSMType(detail.type);

	if (isLatLon(detail)) {
		localCenters.set(featureKey(type, detail.id), {lat: detail.lat, lon: detail.lon});
	}

	loadDetails(type, detail.id).catch((): void => {
		// Surfaced by the panel itself.
	});
});

const getType = (tags: Record<string, string>): string => {
	return buildingTypes[tags.building] ?? buildingTypes.yes;
};

const getTags = (tags: Record<string, string>): JSX.Element => {
	const rows = Object.entries(tags).map(([key, value], i) => {
		return (
			<tr key={i}>
				<td>{key}</td>
				<td>{value}</td>
			</tr>
		);
	});

	return (
		<table className={styles.tags__table}>
			<tbody>
				{rows}
			</tbody>
		</table>
	);
};

const SelectionPanel: React.FC = () => {
	const atoms = useContext(AtomsContext);
	const [activeFeature, setActiveFeature] = useRecoilState(atoms.activeFeature);
	const [selected, setSelected] = useState<SelectedFeature>(null);
	const [details, setDetails] = useState<{key: string; value: FeatureDetails}>(null);
	const [failedKey, setFailedKey] = useState<string>(null);
	const [plateau, setPlateau] = useState<{key: string; value: PlateauInfo | null}>(null);
	const [place, setPlace] = useState<{key: string; value: {name: string; name_en?: string | null} | null}>(null);

	const closeCallback = useCallback(() => {
		if (activeFeature === null) {
			setSelected(null);
		}
	}, [activeFeature]);

	useEffect((): (() => void) | undefined => {
		if (!activeFeature) {
			return undefined;
		}

		const type = toOSMType(activeFeature.type);
		const id = activeFeature.id;
		const key = featureKey(type, id);

		setSelected({type, id, key});
		setFailedKey(null);

		const cachedDetails = detailsCache.get(key);

		if (cachedDetails) {
			setDetails({key, value: cachedDetails});
			return undefined;
		}

		let cancelled = false;

		loadDetails(type, id).then(value => {
			if (!cancelled) {
				setDetails({key, value});
			}
		}).catch(() => {
			if (!cancelled) {
				setFailedKey(key);
			}
		});

		return (): void => {
			cancelled = true;
		};
	}, [activeFeature]);

	const key = selected?.key ?? null;
	const tags = details && details.key === key ? details.value.tags : null;
	const failed = key !== null && failedKey === key;
	const center = key ? (localCenters.get(key) ?? (details?.key === key ? details.value.center : null)) : null;
	const pl = plateau && plateau.key === key ? plateau.value : null;
	const pv = place && place.key === key ? place.value : null;
	const placeName = pv ? (pv.name_en && pv.name_en !== pv.name ? `${pv.name} · ${pv.name_en}` : pv.name) : null;
	const name = tags?.name ?? pl?.name ?? placeName ?? null;

	useEffect((): (() => void) | undefined => {
		if (!key || !isLatLon(center)) {
			return undefined;
		}
		let cancelled = false;
		if (placeNameCache.has(key)) {
			setPlace({key, value: placeNameCache.get(key)});
		} else {
			fetch(`/api/building-name?lat=${center.lat.toFixed(6)}&lon=${center.lon.toFixed(6)}`)
				.then(r => r.ok ? r.json() : null)
				.then((value: {name: string; name_en?: string | null} | null) => {
					placeNameCache.set(key, value);
					if (!cancelled) setPlace({key, value});
				})
				.catch((): void => {
					// name lookup is best-effort
				});
		}
		if (plateauCache.has(key)) {
			setPlateau({key, value: plateauCache.get(key)});
		} else {
			fetch(`/api/building?lat=${center.lat.toFixed(6)}&lon=${center.lon.toFixed(6)}`)
				.then(r => r.ok ? r.json() : null)
				.then((value: PlateauInfo | null) => {
					plateauCache.set(key, value);
					if (!cancelled) setPlateau({key, value});
				})
				.catch((): void => {
					// PLATEAU lookup is optional (covers central Tokyo only)
				});
		}
		return (): void => {
			cancelled = true;
		};
	}, [key, center?.lat, center?.lon]);

	const goHere = (mode: GoMode): void => {
		if (!isLatLon(center)) {
			return;
		}

		window.dispatchEvent(new CustomEvent('guide:route', {
			detail: {lat: center.lat, lon: center.lon, name: name ?? 'Selected building', mode}
		}));
		setActiveFeature(null); // get out of the way of the route overview
	};

	let innerClassNames = styles.selectionInfo;
	if (activeFeature === null) {
		innerClassNames += ' ' + styles['selectionInfo--hidden'];
	}

	const featureTypeLabel = selected?.type === 'relation' ? 'Relation' : 'Way';
	const osmURL = selected ? `https://www.openstreetmap.org/${selected.type}/${selected.id}` : null;
	const idURL = selected ? `https://www.openstreetmap.org/edit?${selected.type}=${selected.id}` : null;
	const goDisabled = !isLatLon(center);

	let header: React.ReactNode = <Skeleton className={styles.skeleton} width={'50%'}/>;
	if (tags) {
		header = name ?? 'Unnamed building';
	} else if (name) {
		header = name;
	} else if (failed || pl) {
		header = pl?.usage ? `${pl.usage} building` : 'Building';
	}

	return (
		<Panel className={styles.selectionInfoPanel}>
			<div className={innerClassNames} onTransitionEnd={closeCallback}>
				<div className={styles.selectionInfo__close}>
					<PanelCloseButton
						onClick={(): void => {
							setActiveFeature(null);
						}}
					/>
				</div>
				<SkeletonTheme
					baseColor="#fff"
					highlightColor="#ddd"
					duration={2}
				>
					<div className={styles.selectionInfo__header}>
						{header}
					</div>
					<div className={styles.selectionInfo__description}>
						{tags ? `${getType(tags)} · ` : ''}
						{selected ? `${featureTypeLabel} №${selected.id}` : ''}
					</div>
					<div className={styles.go}>
						<button
							className={styles.go__button + ' ' + styles['go__button--walk']}
							disabled={goDisabled}
							onClick={(): void => goHere('walk')}
						>
							<MdDirectionsWalk className={styles.go__icon}/>
							<span>{goDisabled ? 'Locating…' : 'Walk here'}</span>
						</button>
						<button
							className={styles.go__button + ' ' + styles['go__button--bike']}
							disabled={goDisabled}
							onClick={(): void => goHere('bike')}
						>
							<MdDirectionsBike className={styles.go__icon}/>
							<span>{goDisabled ? 'Locating…' : 'Bike here'}</span>
						</button>
					</div>
					<button
						className={styles.setStart}
						disabled={goDisabled}
						onClick={(): void => {
							if (isLatLon(center)) {
								window.dispatchEvent(new CustomEvent('guide:origin', {detail: {lat: center.lat, lon: center.lon, name: name ?? 'Selected building'}}));
							}
						}}
					>Set as start point</button>
					{pl && <div className={styles.plateau}>
						<div><b>{pl.height_m ? `${Math.round(pl.height_m)} m` : '–'}</b><span>Height</span></div>
						<div><b>{pl.storeys ?? '–'}</b><span>Floors</span></div>
						<div><b>{pl.usage ?? '–'}</b><span>{pl.usage_ja ?? 'Use'}</span></div>
						<small>{pl.address ? `${pl.address} · ` : ''}PLATEAU (MLIT / Tokyo Metropolitan Govt), CC BY 4.0</small>
					</div>}
					<div className={styles.links}>
						{
							selected && (
								<a className={styles.links__anchor} href={osmURL} target='_blank' rel='noreferrer'>
									<ModalButton
										icon={<div className={styles.imageIcon + ' ' + styles['imageIcon--osm']} />}
										text={'Open on openstreetmap.org'}
									/>
								</a>
							)
						}
						{
							selected && (
								<a className={styles.links__anchor} href={idURL} target='_blank' rel='noreferrer'>
									<ModalButton
										icon={<div className={styles.imageIcon + ' ' + styles['imageIcon--id']} />}
										text={'Edit in iD'}
									/>
								</a>
							)
						}
					</div>
					{
						tags ? (
							<div className={styles.tags}>{getTags(tags)}</div>
						) : failed && pl ? null : failed ? (
							<div className={styles.error}>Couldn&apos;t load building details. Check your connection and reselect the building.</div>
						) : (
							<Skeleton className={styles.skeleton} height={'135px'} borderRadius={'12px'}/>
						)
					}
				</SkeletonTheme>
			</div>
		</Panel>
	);
};

export default React.memo(SelectionPanel);
