import { describe, expect, test } from "bun:test";
import {
	parseArgs,
	parseIds,
	selectNorms,
} from "../src/ingest-analisis-args.ts";

const base = ["bun", "cli.ts"];

describe("parseArgs", () => {
	test("defaults with no args", () => {
		expect(parseArgs(base)).toEqual({
			dbPath: "./data/leyabierta.db",
			concurrency: 6,
			jsonDir: "./data/json",
			ids: null,
		});
	});

	test("positional db path and flags", () => {
		const a = parseArgs([...base, "x.db", "--concurrency", "3", "--json", "j"]);
		expect(a.dbPath).toBe("x.db");
		expect(a.concurrency).toBe(3);
		expect(a.jsonDir).toBe("j");
	});

	test("a flag in argv[2] is not the db path", () => {
		const a = parseArgs([...base, "--ids", "A,B"]);
		expect(a.dbPath).toBe("./data/leyabierta.db");
		expect(a.ids).toEqual(["A", "B"]);
	});

	test("--ids with db path and concurrency", () => {
		const a = parseArgs([...base, "x.db", "--ids", "A", "--concurrency", "2"]);
		expect(a.dbPath).toBe("x.db");
		expect(a.ids).toEqual(["A"]);
		expect(a.concurrency).toBe(2);
	});

	test("--ids with no value yields an empty list", () => {
		expect(parseArgs([...base, "--ids"]).ids).toEqual([]);
	});
});

describe("parseIds", () => {
	test("trims, drops empties, dedupes", () => {
		expect(parseIds(" A, B ,,A,")).toEqual(["A", "B"]);
	});
	test("undefined or blank is empty", () => {
		expect(parseIds(undefined)).toEqual([]);
		expect(parseIds(" , ")).toEqual([]);
	});
});

describe("selectNorms", () => {
	const all = [{ id: "A" }, { id: "B" }, { id: "C" }];

	test("no ids selects everything", () => {
		expect(selectNorms(all, null)).toEqual({ norms: all, unknown: [] });
	});

	test("restricts to ids and keeps DB order", () => {
		const r = selectNorms(all, ["C", "A"]);
		expect(r.norms).toEqual([{ id: "A" }, { id: "C" }]);
		expect(r.unknown).toEqual([]);
	});

	test("reports unknown ids", () => {
		const r = selectNorms(all, ["B", "Z"]);
		expect(r.norms).toEqual([{ id: "B" }]);
		expect(r.unknown).toEqual(["Z"]);
	});
});
