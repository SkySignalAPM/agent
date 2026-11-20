import { expect } from "chai";
import {
	computeQuerySignature,
	computeParamsSignature
} from "../../../../../lib/collectors/aggregation/QuerySignature.js";

describe("QuerySignature", function () {
	it("same shape different values hashes identically", function () {
		const a = computeQuerySignature(
			{ userId: "abc", channelId: "123" },
			{ sort: { createdAt: -1 }, limit: 50 }
		);
		const b = computeQuerySignature(
			{ userId: "xyz", channelId: "999" },
			{ sort: { createdAt: -1 }, limit: 50 }
		);
		expect(a).to.equal(b);
	});

	it("different shape hashes differently", function () {
		const a = computeQuerySignature({ userId: "abc" }, {});
		const b = computeQuerySignature({ userId: "abc", archived: true }, {});
		expect(a).to.not.equal(b);
	});

	it("order-independent on object keys", function () {
		const a = computeQuerySignature({ userId: "abc", channelId: "123" }, {});
		const b = computeQuerySignature({ channelId: "999", userId: "xyz" }, {});
		expect(a).to.equal(b);
	});

	it("different options hash differently", function () {
		const a = computeQuerySignature({ userId: "abc" }, { limit: 50 });
		const b = computeQuerySignature({ userId: "abc" }, { limit: 100 });
		expect(a).to.not.equal(b);
	});

	it("handles nested objects", function () {
		const a = computeQuerySignature({ $or: [{ a: 1 }, { b: 2 }] }, {});
		const b = computeQuerySignature({ $or: [{ a: 99 }, { b: 88 }] }, {});
		expect(a).to.equal(b);
	});

	it("handles null and arrays", function () {
		const a = computeQuerySignature({ tags: ["x", "y"], deleted: null }, {});
		const b = computeQuerySignature({ tags: ["a", "b"], deleted: null }, {});
		expect(a).to.equal(b);
	});

	it("computeParamsSignature hashes array shape not values", function () {
		const a = computeParamsSignature(["abc", true]);
		const b = computeParamsSignature(["xyz", false]);
		expect(a).to.equal(b);
	});

	it("$in arrays of any length share one signature", function () {
		const ids = (n) => Array.from({ length: n }, (_, i) => `id${i}`);
		const one = computeQuerySignature({ _id: { $in: ids(1) } }, {});
		expect(computeQuerySignature({ _id: { $in: ids(2) } }, {})).to.equal(one);
		expect(computeQuerySignature({ _id: { $in: ids(500) } }, {})).to.equal(one);
	});

	it("distinct $or branch shapes stay distinct", function () {
		const a = computeQuerySignature({ $or: [{ a: 1 }, { b: 2 }] }, {});
		const b = computeQuerySignature({ $or: [{ a: 1 }] }, {});
		expect(a).to.not.equal(b);
	});

	it("params: nested array length is ignored, top-level arity is not", function () {
		expect(computeParamsSignature([["x"]])).to.equal(computeParamsSignature([["x", "y", "z"]]));
		expect(computeParamsSignature(["a"])).to.not.equal(computeParamsSignature(["a", "b"]));
	});

	it("null selector produces stable signature", function () {
		expect(computeQuerySignature(null, {})).to.equal(computeQuerySignature({}, {}));
	});
});
