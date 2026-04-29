/**
 * Legislative domain model.
 *
 * Multi-country ready. Each country defines its own rank values
 * but the core model is generic.
 */

// ─── Enums ───

export type Rank = string & {};

export const Rank = {
	// Spain
	CONSTITUCION: "constitucion" as Rank,
	LEY_ORGANICA: "ley_organica" as Rank,
	LEY: "ley" as Rank,
	REAL_DECRETO_LEY: "real_decreto_ley" as Rank,
	REAL_DECRETO_LEGISLATIVO: "real_decreto_legislativo" as Rank,
	REAL_DECRETO: "real_decreto" as Rank,
	ORDEN: "orden" as Rank,
	RESOLUCION: "resolucion" as Rank,
	ACUERDO_INTERNACIONAL: "acuerdo_internacional" as Rank,
	CIRCULAR: "circular" as Rank,
	INSTRUCCION: "instruccion" as Rank,
	DECRETO: "decreto" as Rank,
	REGLAMENTO: "reglamento" as Rank,
	ACUERDO: "acuerdo" as Rank,
	OTHER: "otro" as Rank,
} as const;

export type CommitType =
	| "nueva"
	| "reforma"
	| "derogacion"
	| "correccion"
	| "bootstrap"
	| "fix-pipeline";

export type NormStatus = "vigente" | "derogada" | "parcialmente_derogada";

// ─── Core model ───

export interface Paragraph {
	readonly cssClass: string;
	readonly text: string;
}

export interface Version {
	readonly normId: string;
	readonly publishedAt: string; // ISO date
	readonly effectiveAt: string; // ISO date
	readonly paragraphs: readonly Paragraph[];
}

export interface Block {
	readonly id: string;
	readonly type: string;
	readonly title: string;
	readonly versions: readonly Version[];
}

export interface NormMetadata {
	readonly title: string;
	readonly shortTitle: string;
	readonly id: string;
	readonly country: string; // ISO 3166-1 alpha-2
	readonly rank: Rank;
	readonly publishedAt: string; // ISO date
	readonly status: NormStatus;
	readonly department: string;
	readonly source: string; // official URL
	readonly updatedAt?: string; // ISO date
	readonly pdfUrl?: string;
	readonly subjects?: readonly string[];
	readonly notes?: string;
}

export interface Reform {
	readonly date: string; // ISO date
	readonly normId: string;
	readonly affectedBlockIds: readonly string[];
}

export interface NormAnalisis {
	readonly materias: string[];
	readonly notas: string[];
	readonly referencias: {
		readonly anteriores: ReadonlyArray<{
			normId: string;
			relation: string;
			text: string;
		}>;
		readonly posteriores: ReadonlyArray<{
			normId: string;
			relation: string;
			text: string;
		}>;
	};
}

export interface Norm {
	readonly metadata: NormMetadata;
	readonly blocks: readonly Block[];
	readonly reforms: readonly Reform[];
	readonly analisis?: NormAnalisis;
}

// ─── Git commit ───

export interface CommitInfo {
	readonly commitType: CommitType;
	readonly subject: string;
	readonly body: string;
	readonly trailers: Record<string, string>;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string; // ISO date
	readonly filePath: string;
	readonly content: string;
}
