// Visvalingam polyline simplification algorithm, adapted from
// http://bost.ocks.org/mike/simplify/simplify.js
// modified to keep points on edges

const visvalingam = function(points, pointsToKeep) {

	let heap = minHeap();
	let maxArea = 0;
	let triangle;
	let triangles = [];

	// make a copy of points, ensure pairs only
	points = points.map(function(d) {
		return d.slice(0, 2);
	});

	// add area of triangle to center vertice
	for (let i = 1, n = points.length - 1; i < n; ++i) {
		triangle = points.slice(i - 1, i + 2);
		if (triangle[1][2] = area(triangle)) {
			triangles.push(triangle);
			heap.push(triangle);
		};
	};

	// add neigbouring triangles
	for (let i = 0, n = triangles.length; i < n; ++i) {
		triangle = triangles[i];
		triangle.previous = triangles[i - 1];
		triangle.next = triangles[i + 1];
	};

	while (triangle = heap.pop()) {

		// If the area of the current point is less than that of the previous point
		// to be eliminated, use the latters area instead. This ensures that the
		// current point cannot be eliminated without eliminating previously-
		// eliminated points.
		if (triangle[1][2] < maxArea) {
			triangle[1][2] = maxArea;
		} else {
			maxArea = triangle[1][2];
		};

		if (triangle.previous) {
			triangle.previous.next = triangle.next;
			triangle.previous[2] = triangle[2];
			update(triangle.previous);
		} else {
			triangle[0][2] = triangle[1][2];
		};

		if (triangle.next) {
			triangle.next.previous = triangle.previous;
			triangle.next[0] = triangle[0];
			update(triangle.next);
		} else {
			triangle[2][2] = triangle[1][2];
		};
	};

	function update(triangle) {
		heap.remove(triangle);
		triangle[1][2] = area(triangle);
		heap.push(triangle);
	};

	let weights = points.map(d=>{
		return d.length < 3 ? Infinity : d[2] += Math.random(); // break ties
	}).sort(function(a, b) {
		return b - a;
	});

	// ensure pointsToKeep does not exceed the number of points
	pointsToKeep = Math.min(pointsToKeep, weights.length);

	return points.filter(d=>{ // modification: prevent removal of points on edge
		return (d[2] > weights[pointsToKeep] || d[0]<=0 || d[0]>=4096 || d[1]<=0 || d[1]>=4096);
	}).map(d=>{ // remove weights
		return d.slice(0,2);
	});

};

function compare(a, b) {
	return a[1][2] - b[1][2];
};

function area(t) {
	return Math.abs((t[0][0] - t[2][0]) * (t[1][1] - t[0][1]) - (t[0][0] - t[1][0]) * (t[2][1] - t[0][1]));
};

function minHeap() {

	let heap = {};
	let array = [];

	heap.push = function() {
		for (let i = 0, n = arguments.length; i < n; ++i) {
			let object = arguments[i];
			up(object.index = array.push(object) - 1);
		};
		return array.length;
	};

	heap.pop = function() {
		let removed = array[0];
		let object = array.pop();
		if (array.length) {
			array[object.index = 0] = object;
			down(0);
		};
		return removed;
	};

	heap.size = function() {
		return array.length;
	};

	heap.remove = function(removed) {
		let i = removed.index;
		let object = array.pop();
		if (i !== array.length) {
			array[object.index = i] = object;
			(compare(object, removed) < 0 ? up : down)(i);
		};
		return i;
	};

	function up(i) {
		let object = array[i];
		while (i > 0) {
			let up = ((i + 1) >> 1) - 1;
			let parent = array[up];
			if (compare(object, parent) >= 0) break;
			array[parent.index = i] = parent;
			array[object.index = i = up] = object;
		};
	};

	function down(i) {
		let object = array[i];
		while (true) {
			let right = (i + 1) * 2;
			let left = right - 1;
			let down = i;
			let child = array[down];
			if (left < array.length && compare(array[left], child) < 0) child = array[down = left];
			if (right < array.length && compare(array[right], child) < 0) child = array[down = right];
			if (down === i) break;
			array[child.index = i] = child;
			array[object.index = i = down] = object;
		};
	};

	return heap;

};

module.exports = visvalingam;