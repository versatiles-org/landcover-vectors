// enforce MVT 2.1 polygon ring winding
// see https://github.com/mapbox/vector-tile-spec/blob/master/2.1/README.md#4333-polygon-geometry-type
//
// the surveyor's (shoelace) formula applied to the ring vertices in tile
// coordinates must yield a POSITIVE area for exterior rings and a NEGATIVE
// area for interior (hole) rings. potrace emits the relative winding the other
// way around and nothing downstream corrects it, so we normalize it here.
//
// the exterior/interior role of a ring is derived from its even-odd nesting
// depth (how many other rings of the same feature contain it) rather than from
// the incoming winding, so the result is correct regardless of the tracer's
// orientation convention. once the role is known the winding is forced to the
// canonical sign, reversing the ring's vertices when necessary.

// signed area via the surveyor's formula; positive = MVT exterior orientation
export const signedArea = function (ring) {
	let sum = 0;
	for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
		sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return sum / 2;
};

// ray-casting point-in-polygon test
const pointInRing = function (pt, ring) {
	let inside = false;
	for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
		if (
			ring[i][1] > pt[1] !== ring[j][1] > pt[1] &&
			pt[0] < ((ring[j][0] - ring[i][0]) * (pt[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]
		) {
			inside = !inside;
		}
	}
	return inside;
};

// rewind every ring of a feature's geometry to MVT 2.1 winding
const rewind = function (geometry) {
	return geometry.map((ring, i) => {
		// even-odd nesting depth: a ring is a hole when contained by an odd
		// number of the feature's other rings
		let depth = 0;
		for (let j = 0; j < geometry.length; j++) {
			if (j !== i && pointInRing(ring[0], geometry[j])) depth++;
		}

		const exterior = depth % 2 === 0; // even depth → exterior, odd → hole
		const positive = signedArea(ring) > 0; // current orientation

		// exterior wants positive area, interior wants negative; reverse if not
		return exterior === positive ? ring : ring.slice().reverse();
	});
};

export default rewind;
