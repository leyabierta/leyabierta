import { afterEach, describe, expect, test } from "bun:test";
import { BoeDiarioClient, EMPTY_DAY } from "../spain/boe-diario-client.ts";
import { BoeDiarioDiscovery } from "../spain/boe-diario-discovery.ts";

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
