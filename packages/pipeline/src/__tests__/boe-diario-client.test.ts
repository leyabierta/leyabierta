import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoeDiarioClient, EMPTY_DAY } from "../spain/boe-diario-client.ts";
import { BoeDiarioDiscovery } from "../spain/boe-diario-discovery.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(response: { status: number; body?: unknown }): void {
	globalThis.fetch = (async () =>
		new Response(
			response.body !== undefined ? JSON.stringify(response.body) : "",
			{ status: response.status },
		)) as unknown as typeof fetch;
}

describe("BoeDiarioClient.getSumario", () => {
	test("unwraps data.sumario, not the raw envelope", async () => {
		mockFetch({
			status: 200,
			body: {
				status: { code: "200", text: "OK" },
				data: {
					sumario: {
						diario: [
							{
								seccion: [
									{
										codigo: "1",
										departamento: [
											{
												epigrafe: [
													{
														item: [
															{
																identificador: "BOE-A-2026-1",
																titulo: "Norma.",
																url_xml: "https://example/xml?id=BOE-A-2026-1",
															},
														],
													},
												],
											},
										],
									},
								],
							},
						],
					},
				},
			},
		});

		const client = new BoeDiarioClient(0);
		const sumario = await client.getSumario("20260723");
		expect(sumario).not.toBe(EMPTY_DAY);
		if (sumario === EMPTY_DAY) throw new Error("unreachable");

		// The critical regression check: passing what getSumario() returns
		// straight into discover() must yield items — if getSumario() still
		// returned the raw envelope, this would silently yield zero.
		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(sumario)];
		expect(items).toHaveLength(1);
		expect(items[0]!.id).toBe("BOE-A-2026-1");
	});

	test("real fixture: getSumario() → discover() end-to-end yields the 10 Sección I items", async () => {
		// The fixture is the exact raw envelope shape the BOE API returns
		// (`{status, data:{sumario:{...}}}`) — fed through fetch untouched,
		// with NO manual `.data.sumario` unwrapping in the test. This is the
		// client→discovery contract exercised for real: if getSumario() ever
		// regresses to returning the envelope instead of the inner sumario,
		// this test fails (discover() would see no `.diario` and yield 0).
		const raw = readFileSync(
			join(FIXTURES_DIR, "sumario-20260723.json"),
			"utf-8",
		);
		globalThis.fetch = (async () =>
			new Response(raw, { status: 200 })) as unknown as typeof fetch;

		const client = new BoeDiarioClient(0);
		const sumario = await client.getSumario("20260723");
		expect(sumario).not.toBe(EMPTY_DAY);
		if (sumario === EMPTY_DAY) throw new Error("unreachable");

		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(sumario)];

		expect(items).toHaveLength(10);
		expect(items.every((i) => i.section === "1")).toBe(true);
		expect(items.map((i) => i.id)).toContain("BOE-A-2026-16010");
	});

	test("returns EMPTY_DAY on 404 without throwing", async () => {
		mockFetch({ status: 404 });
		const client = new BoeDiarioClient(0);
		const result = await client.getSumario("20260726");
		expect(result).toBe(EMPTY_DAY);
	});

	test("throws on a non-200 status code", async () => {
		mockFetch({
			status: 200,
			body: { status: { code: "500", text: "Internal error" } },
		});
		const client = new BoeDiarioClient(0);
		await expect(client.getSumario("20260723")).rejects.toThrow();
	});
});
