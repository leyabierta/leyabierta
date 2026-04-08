/**
 * JSON-based state store for tracking bootstrap progress.
 *
 * Primary source of truth for idempotency — tracks which norms
 * have been processed, their commit SHAs, and error states.
 */

export interface NormState {
	id: string;
	status: "done" | "error" | "skipped";
	commits?: number;
	lastCommitSha?: string;
	error?: string;
	processedAt: string; // ISO timestamp
	fechaActualizacion?: string; // BOE's fecha_actualizacion timestamp
}

export interface StateData {
	version: 1;
	country: string;
	lastBoeUpdate?: string; // watermark: most recent fecha_actualizacion we've processed
	norms: Record<string, NormState>;
}

export class StateStore {
	private data: StateData;
	private dirty = false;

	constructor(
		private filePath: string,
		country: string,
	) {
		this.data = { version: 1, country, norms: {} };
	}

	async load(): Promise<void> {
		try {
			const file = Bun.file(this.filePath);
			if (await file.exists()) {
				this.data = (await file.json()) as StateData;
			}
		} catch {
			// Start fresh if corrupt
		}
	}

	isProcessed(normId: string): boolean {
		const s = this.data.norms[normId]?.status;
		return s === "done" || s === "skipped";
	}

	get lastBoeUpdate(): string | undefined {
		return this.data.lastBoeUpdate;
	}

	setLastBoeUpdate(ts: string): void {
		this.data.lastBoeUpdate = ts;
		this.dirty = true;
	}

	markDone(
		normId: string,
		commits: number,
		lastSha?: string,
		fechaActualizacion?: string,
	): void {
		this.data.norms[normId] = {
			id: normId,
			status: "done",
			commits,
			lastCommitSha: lastSha,
			processedAt: new Date().toISOString(),
			fechaActualizacion,
		};
		this.dirty = true;
	}

	markError(normId: string, error: string): void {
		this.data.norms[normId] = {
			id: normId,
			status: "error",
			error,
			processedAt: new Date().toISOString(),
		};
		this.dirty = true;
	}

	markSkipped(normId: string): void {
		this.data.norms[normId] = {
			id: normId,
			status: "skipped",
			processedAt: new Date().toISOString(),
		};
		this.dirty = true;
	}

	get stats(): {
		done: number;
		errors: number;
		skipped: number;
		total: number;
	} {
		const norms = Object.values(this.data.norms);
		return {
			done: norms.filter((n) => n.status === "done").length,
			errors: norms.filter((n) => n.status === "error").length,
			skipped: norms.filter((n) => n.status === "skipped").length,
			total: norms.length,
		};
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		await Bun.write(this.filePath, JSON.stringify(this.data, null, 2));
		this.dirty = false;
	}
}
