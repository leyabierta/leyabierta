import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	check,
	commit,
	defaultState,
	defaultStatePath,
	type ListClient,
	loadState,
	markPushed,
	saveState,
	shouldPush,
} from "../src/boe-watch.ts";
import type { BoeListItem } from "../src/spain/boe-client.ts";

let dir: string;
let statePath: string;
let dbPath: string;

function item(id: string, stamp?: string): BoeListItem {
	return { identificador: id, fecha_actualizacion: stamp } as BoeListItem;
}

/** Fake client serving a flat, already DESC-ordered list in pages. */
function fakeClient(all: BoeListItem[]): ListClient & { calls: number } {
	const c = {
		calls: 0,
		async list(limit: number, offset = 0) {
			c.calls++;
			return { data: all.slice(offset, offset + limit) };
		},
	};
	return c;
}

function stamp(n: number): string {
	// Higher n = newer
	return `20260930T${String(n).padStart(6, "0")}Z`;
}

/** n items, newest first: ids X{n}..X1 */
function series(n: number, prefix = "X"): BoeListItem[] {
	return Array.from({ length: n }, (_, i) =>
		item(`${prefix}${n - i}`, stamp(n - i)),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "boe-watch-"));
	statePath = join(dir, "watch-state.json");
	dbPath = join(dir, "test.db");
	const db = new Database(dbPath);
	db.run("CREATE TABLE norms(id TEXT PRIMARY KEY)");
	for (const id of ["X1", "X2", "X3", "X4", "X5"]) {
		db.run("INSERT INTO norms(id) VALUES (?)", [id]);
	}
	db.close();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("check", () => {
	test("first run sets a baseline without reporting the catalogue", async () => {
		const client = fakeClient(series(250));
		const res = await check({ statePath, dbPath, client });
		expect(res).toEqual({
			changed: false,
			latest: stamp(250),
			ids: [],
			newIds: [],
		});
		const state = loadState(statePath);
		expect(state.latest).toBe(stamp(250));
		expect(state.lastCheckAt).not.toBeNull();
		expect(client.calls).toBe(1);
	});

	test("early stops at the watermark and does not move it", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(3) });
		const client = fakeClient(series(5));
		const res = await check({ statePath, dbPath, client });
		expect(res.changed).toBe(true);
		expect(res.ids).toEqual(["X5", "X4"]);
		expect(res.latest).toBe(stamp(5));
		expect(loadState(statePath).latest).toBe(stamp(3));
		expect(loadState(statePath).lastCheckAt).not.toBeNull();
		expect(client.calls).toBe(1);
	});

	test("no change when the top item is at the watermark", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(5) });
		const res = await check({
			statePath,
			dbPath,
			client: fakeClient(series(5)),
		});
		expect(res).toEqual({
			changed: false,
			latest: stamp(5),
			ids: [],
			newIds: [],
		});
	});

	test("newIds are those missing from the norms table", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(0) });
		const all = [item("NEW1", stamp(9)), ...series(3)];
		const res = await check({ statePath, dbPath, client: fakeClient(all) });
		expect(res.ids).toEqual(["NEW1", "X3", "X2", "X1"]);
		expect(res.newIds).toEqual(["NEW1"]);
	});

	test("dedupes ids and ignores items without fecha_actualizacion", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(1) });
		const all = [
			item("A", stamp(9)),
			item("NOSTAMP"),
			item("A", stamp(8)),
			item("B", stamp(7)),
		];
		const res = await check({ statePath, dbPath, client: fakeClient(all) });
		expect(res.ids).toEqual(["A", "B"]);
		expect(res.latest).toBe(stamp(9));
	});

	test("pages across boundaries until the watermark", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(50) });
		const client = fakeClient(series(250));
		const res = await check({ statePath, dbPath, client });
		expect(res.ids.length).toBe(200);
		expect(client.calls).toBe(3);
	});

	test("warns when max pages is hit before the watermark", async () => {
		saveState(statePath, { ...defaultState(), latest: stamp(1) });
		const warn = spyOn(console, "error").mockImplementation(() => {});
		try {
			const client = fakeClient(series(500));
			const res = await check({ statePath, dbPath, client, maxPages: 2 });
			expect(client.calls).toBe(2);
			expect(res.ids.length).toBe(200);
			expect(
				warn.mock.calls.some((c) => String(c[0]).includes("max pages")),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("commit", () => {
	test("never moves the watermark backwards and sets pending flags", () => {
		commit({ statePath, latest: stamp(5) });
		let s = commit({ statePath, latest: stamp(3) });
		expect(s.latest).toBe(stamp(5));
		expect(s.pendingPush).toBe(true);
		expect(s.pendingHasNew).toBe(false);
		s = commit({ statePath, latest: stamp(7), isNew: true });
		expect(s.latest).toBe(stamp(7));
		expect(s.pendingHasNew).toBe(true);
		s = commit({ statePath, latest: stamp(8) });
		expect(s.pendingHasNew).toBe(true);
	});

	test("rejects a malformed timestamp", () => {
		expect(() => commit({ statePath, latest: "2026-09-30" })).toThrow();
		expect(existsSync(statePath)).toBe(false);
	});
});

describe("shouldPush", () => {
	const now = () => new Date("2026-09-30T12:00:00Z");
	const base = defaultState();

	test("nothing pending", () => {
		saveState(statePath, base);
		expect(shouldPush({ statePath, minIntervalMin: 60, now }).push).toBe(false);
	});

	test("brand-new law pushes immediately", () => {
		saveState(statePath, {
			...base,
			pendingPush: true,
			pendingHasNew: true,
			lastPushAt: "2026-09-30T11:59:00Z",
		});
		expect(shouldPush({ statePath, minIntervalMin: 60, now }).push).toBe(true);
	});

	test("never pushed before", () => {
		saveState(statePath, { ...base, pendingPush: true });
		expect(shouldPush({ statePath, minIntervalMin: 60, now }).push).toBe(true);
	});

	test("interval elapsed", () => {
		saveState(statePath, {
			...base,
			pendingPush: true,
			lastPushAt: "2026-09-30T10:59:00Z",
		});
		expect(shouldPush({ statePath, minIntervalMin: 60, now }).push).toBe(true);
	});

	test("interval not elapsed reports minutes remaining", () => {
		saveState(statePath, {
			...base,
			pendingPush: true,
			lastPushAt: "2026-09-30T11:30:00Z",
		});
		const res = shouldPush({ statePath, minIntervalMin: 60, now });
		expect(res.push).toBe(false);
		expect(res.reason).toContain("30 min");
	});
});

describe("markPushed", () => {
	test("resets pending flags and stamps lastPushAt", () => {
		commit({ statePath, latest: stamp(5), isNew: true });
		const s = markPushed({
			statePath,
			now: () => new Date("2026-09-30T12:00:00Z"),
		});
		expect(s.pendingPush).toBe(false);
		expect(s.pendingHasNew).toBe(false);
		expect(s.lastPushAt).toBe("2026-09-30T12:00:00.000Z");
		expect(s.latest).toBe(stamp(5));
	});
});

describe("state file", () => {
	test("missing file gives defaults", () => {
		expect(loadState(statePath)).toEqual(defaultState());
	});

	test("corrupt file gives defaults and warns", () => {
		writeFileSync(statePath, "{not json");
		const warn = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(loadState(statePath)).toEqual(defaultState());
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("writes are atomic: no temp files left, valid JSON", () => {
		saveState(statePath, { ...defaultState(), latest: stamp(1) });
		saveState(statePath, { ...defaultState(), latest: stamp(2) });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(JSON.parse(readFileSync(statePath, "utf8")).latest).toBe(stamp(2));
	});

	test("default path sits next to the DB", () => {
		expect(defaultStatePath("/data/leyabierta.db")).toBe(
			"/data/watch-state.json",
		);
	});
});
