import crypto from "crypto";

function typeTokens(value) {
	if (value === null) return "<null>";
	if (Array.isArray(value)) {
		// Distinct element shapes, sorted: {$in: ids} hashes the same for any length,
		// while $or branches with different shapes stay distinct.
		const byJson = new Map();
		for (const el of value) {
			const shape = typeTokens(el);
			byJson.set(JSON.stringify(shape), shape);
		}
		return [...byJson.keys()].sort().map((k) => byJson.get(k));
	}
	if (typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = typeTokens(value[key]);
		}
		return out;
	}
	switch (typeof value) {
		case "string":
			return "<string>";
		case "number":
			return "<number>";
		case "boolean":
			return "<bool>";
		default:
			return "<unknown>";
	}
}

function sha1Short(s) {
	return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

export function computeQuerySignature(selector, options = {}) {
	const shape = typeTokens(selector || {});
	const shapeHash = sha1Short(JSON.stringify(shape));
	const limit = options.limit ? `_l${options.limit}` : "";
	const sort = options.sort ? `|s=${Object.keys(options.sort).sort().join(",")}` : "";
	const hasProj = !!(options.fields || options.projection);
	const proj = hasProj ? "|p=projected" : "|p=none";
	return `${shapeHash}${limit}${sort}${proj}`;
}

export function computeParamsSignature(params = []) {
	// Top level stays positional: (id) and (id, opts) are different call shapes.
	const shape = Array.isArray(params) ? params.map(typeTokens) : typeTokens(params);
	return sha1Short(JSON.stringify(shape));
}

export function buildSample(value) {
	return typeTokens(value);
}
