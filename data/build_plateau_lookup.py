#!/usr/bin/env python3
"""Build data/plateau_buildings.json.gz for plateau.js (building-attribute lookup).

Source: Tokyo PLATEAU 2025 CityGML archives (CC BY 4.0) cached by the Bikr/nagare
project under ~/Downloads/nagare/data-prep/raw/plateau/. The derived Bikr outputs
(plateau_heights.gpkg, buildings_chuo.geojson) only carry height/storeys, so this
script re-reads the CityGML to also get gml:name, bldg:usage and yearOfConstruction.

Stdlib only.  Usage:
    python3 data/build_plateau_lookup.py                      # all 9 cached wards -> .json.gz
    python3 data/build_plateau_lookup.py --wards chiyoda chuo minato --no-gzip

Output record (null fields skipped):
    {"c":[lat,lon], "f":[ring,...], "h":m, "s":storeys, "y":year, "u":usage_code,
     "n":name, "a":address_index}
ring = flat int list in 1e-6 deg: [dlat0, dlon0, dlat1, dlon1, ...] where the first
pair is relative to c and every further pair is relative to the previous vertex.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import sys
import zipfile
from collections import Counter
from multiprocessing import Pool
from pathlib import Path
from xml.etree import ElementTree as ET

RAW_DIR = Path.home() / "Downloads" / "nagare" / "data-prep" / "raw" / "plateau"
OUT_DEFAULT = Path(__file__).resolve().parent / "plateau_buildings.json"
WARDS = {
    "chiyoda": "13101", "chuo": "13102", "minato": "13103", "shinjuku": "13104",
    "bunkyo": "13105", "taito": "13106", "sumida": "13107", "koto": "13108",
    "shibuya": "13113",
}
USAGE_EN = {
    "401": "Office", "402": "Commercial", "403": "Hotel / lodging",
    "404": "Mixed-use commercial", "411": "Detached house", "412": "Apartment building",
    "413": "House with shop", "414": "Apartments with shops", "415": "House with workshop",
    "421": "Government office", "422": "Education / culture / welfare",
    "431": "Transport / warehouse", "441": "Factory", "451": "Agriculture / fishery",
    "452": "Utility / supply facility", "453": "Defence facility", "454": "Other",
}
GML_IDS = ("{http://www.opengis.net/gml}id", "{http://www.opengis.net/gml/3.2}id")
WANTED = {"usage", "measuredHeight", "storeysAboveGround", "yearOfConstruction",
          "city", "buildingID", "LocalityName"}
GEOM_TAGS = {"lod0FootPrint", "lod0RoofEdge", "lod1Solid", "GroundSurface"}
SIMPLIFY_M = 0.5
M_PER_DEG_LAT = 111_320.0


def ln(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def num(text, lo, hi):
    try:
        v = float(text)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and lo < v <= hi else None


def rings_in(el):
    """Exterior rings under el as lists of (lat, lon, z)."""
    out = []
    for poly in el.iter():
        if ln(poly.tag) != "Polygon":
            continue
        for ext in poly:
            if ln(ext.tag) != "exterior":
                continue
            for pl in ext.iter():
                if ln(pl.tag) == "posList" and pl.text:
                    v = [float(x) for x in pl.text.split()]
                    d = int(pl.attrib.get("srsDimension", 3))
                    pts = [(v[i], v[i + 1], v[i + 2] if d == 3 else 0.0)
                           for i in range(0, len(v) - d + 1, d)]
                    if len(pts) >= 4 and 30 < pts[0][0] < 40:  # EPSG:6697 lat,lon,h
                        out.append(pts)
                    break
    return out


def lowest_horizontal(rings):
    flat = [r for r in rings if max(p[2] for p in r) - min(p[2] for p in r) <= 0.75]
    if not flat:
        return []
    zs = [sorted(p[2] for p in r)[len(r) // 2] for r in flat]
    zmin = min(zs)
    return [r for r, z in zip(flat, zs) if z <= zmin + 0.75]


def footprint(geoms):
    for tag in ("lod0FootPrint", "lod0RoofEdge"):
        rings = [r for el in geoms.get(tag, []) for r in rings_in(el)]
        if rings:
            return rings, tag
    rings = [r for el in geoms.get("lod1Solid", []) for r in lowest_horizontal(rings_in(el))]
    if rings:
        return rings, "lod1_base"
    rings = [r for el in geoms.get("GroundSurface", []) for r in rings_in(el)]
    return rings, "ground_surface" if rings else "missing"


def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = (abs(dy * (px - ax) - dx * (py - ay)) / L) if L else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def ring_area_centroid(r):
    a = cx = cy = 0.0
    for i in range(len(r)):
        x0, y0 = r[i - 1]
        x1, y1 = r[i]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    return a / 2, cx, cy


def encode(rings):
    """rings of (lat, lon, z) -> (centroid(lat5, lon5), [flat delta int rings])."""
    lat0 = rings[0][0][0]
    kx = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    simp = []
    for r in rings:
        pts = [(p[1], p[0]) for p in r]  # (lon, lat)
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        m = [((x - pts[0][0]) * kx, (y - pts[0][1]) * M_PER_DEG_LAT) for x, y in pts]
        m.append(m[0])
        kept = rdp(m, SIMPLIFY_M)[:-1]
        if len(kept) >= 3:
            simp.append([(pts[0][0] + mx / kx, pts[0][1] + my / M_PER_DEG_LAT) for mx, my in kept])
    if not simp:
        return None
    A = CX = CY = 0.0
    for r in simp:
        a, cx, cy = ring_area_centroid([(x - simp[0][0][0], y - simp[0][0][1]) for x, y in r])
        A += a
        CX += cx
        CY += cy
    if abs(A) > 1e-14:
        clon = simp[0][0][0] + CX / (6 * A)
        clat = simp[0][0][1] + CY / (6 * A)
    else:
        clon = sum(x for r in simp for x, _ in r) / sum(len(r) for r in simp)
        clat = sum(y for r in simp for _, y in r) / sum(len(r) for r in simp)
    clat, clon = round(clat, 5), round(clon, 5)
    out = []
    for r in simp:
        flat, plat, plon = [], round(clat * 1e6), round(clon * 1e6)
        for x, y in r:
            ilat, ilon = round(y * 1e6), round(x * 1e6)
            flat += [ilat - plat, ilon - plon]
            plat, plon = ilat, ilon
        out.append(flat)
    return (clat, clon), out


def parse_member(task):
    zpath, member, code = task
    stats = Counter()
    recs = []
    with zipfile.ZipFile(zpath) as z, z.open(member) as fh:
        for ev, el in ET.iterparse(fh, events=("end",)):
            t = ln(el.tag)
            if t == "cityObjectMember":
                el.clear()
                continue
            if t != "Building":
                continue
            stats["seen"] += 1
            vals, geoms, name = {}, {}, None
            for ch in el:
                if ln(ch.tag) == "name" and ch.text and ch.text.strip():
                    name = ch.text.strip()
            for d in el.iter():
                dt = ln(d.tag)
                if dt in WANTED and dt not in vals and d.text:
                    vals[dt] = d.text.strip()
                elif dt in GEOM_TAGS:
                    geoms.setdefault(dt, []).append(d)
            rec_code = vals.get("city") or (vals.get("buildingID") or "")[:5]
            if rec_code != code:
                stats["outside_ward"] += 1
                el.clear()
                continue
            gid = next((el.attrib[k] for k in GML_IDS if k in el.attrib), None)
            rings, method = footprint(geoms)
            enc = encode(rings) if rings else None
            el.clear()
            if not enc:
                stats["missing_geometry"] += 1
                continue
            stats["geom_" + method] += 1
            (clat, clon), fr = enc
            rec = {"c": [clat, clon], "f": fr}
            h = num(vals.get("measuredHeight"), 0, 1000)
            s = num(vals.get("storeysAboveGround"), 0, 200)
            y = num(vals.get("yearOfConstruction"), 1800, 2030)
            u = vals.get("usage")
            if h is not None:
                rec["h"] = round(h, 1)
            if s is not None:
                rec["s"] = int(s)
            if y is not None:
                rec["y"] = int(y)
            if u in USAGE_EN:
                rec["u"] = int(u)
            if name:
                rec["n"] = name
            if vals.get("LocalityName"):
                rec["a"] = vals["LocalityName"]
            recs.append((gid, rec))
    return recs, stats


def usage_labels(zpath):
    with zipfile.ZipFile(zpath) as z:
        s = z.read("codelists/Building_usage.xml").decode("utf-8-sig")
    ja = dict((c, d) for d, c in re.findall(
        r"<gml:description>(.*?)</gml:description>\s*<gml:name>(.*?)</gml:name>", s))
    return {c: [USAGE_EN[c], ja.get(c, "")] for c in USAGE_EN}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wards", nargs="+", default=list(WARDS), choices=list(WARDS))
    ap.add_argument("--raw", type=Path, default=RAW_DIR)
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--no-gzip", dest="gzip", action="store_false",
                    help="write plain JSON instead of <out>.gz")
    ap.add_argument("--jobs", type=int, default=None)
    args = ap.parse_args()

    tasks, zips = [], []
    for w in args.wards:
        code = WARDS[w]
        zp = next(args.raw.glob(f"{code}_*citygml*.zip"))
        zips.append(zp)
        with zipfile.ZipFile(zp) as z:
            tasks += [(str(zp), n, code) for n in z.namelist()
                      if n.startswith("udx/bldg/") and n.endswith(".gml")]
    print(f"{len(tasks)} bldg GML files from {len(zips)} archives", file=sys.stderr)

    stats, seen, records = Counter(), set(), []
    with Pool(args.jobs) as pool:
        for i, (recs, st) in enumerate(pool.imap_unordered(parse_member, tasks), 1):
            stats.update(st)
            for gid, rec in recs:
                if gid and gid in seen:
                    stats["duplicate"] += 1
                    continue
                seen.add(gid)
                records.append(rec)
            print(f"  {i}/{len(tasks)} files, {len(records)} buildings", file=sys.stderr)

    records.sort(key=lambda r: (r["c"][0], r["c"][1]))
    addrs = sorted({r["a"] for r in records if "a" in r})
    aidx = {a: i for i, a in enumerate(addrs)}
    for r in records:
        if "a" in r:
            r["a"] = aidx[r["a"]]
    lats = [r["c"][0] for r in records]
    lons = [r["c"][1] for r in records]
    fill = {k: round(100 * sum(k in r for r in records) / len(records), 1)
            for k in ("n", "u", "h", "s", "y", "a")}
    doc = {
        "v": 1,
        "source": "PLATEAU 2025 CityGML, Tokyo Metropolitan Government / MLIT (CC BY 4.0)",
        "wards": args.wards,
        "count": len(records),
        "bbox": [min(lats), min(lons), max(lats), max(lons)],
        "fill_pct": fill,
        "usage": usage_labels(zips[0]),
        "addr": addrs,
        "b": records,
    }
    blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = args.out.with_name(args.out.name + ".gz") if args.gzip else args.out
    if args.gzip:
        blob = gzip.compress(blob, 9)
    out.write_bytes(blob)
    print(json.dumps({"out": str(out), "bytes": len(blob), "count": len(records),
                      "bbox": doc["bbox"], "fill_pct": fill, "stats": stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
