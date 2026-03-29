/**
 * File path generation for norm Markdown files.
 *
 * Maps norm rank to a folder name in the output repo.
 */

import type { NormMetadata, Rank } from "../models.ts";

const RANK_FOLDERS: Record<string, string> = {
	// Spain
	constitucion: "constituciones",
	ley_organica: "leyes-organicas",
	ley: "leyes",
	real_decreto_ley: "reales-decretos-ley",
	real_decreto_legislativo: "reales-decretos-legislativos",
	real_decreto: "reales-decretos",
	orden: "ordenes",
	resolucion: "resoluciones",
	acuerdo_internacional: "acuerdos-internacionales",
	circular: "circulares",
	instruccion: "instrucciones",
	decreto: "decretos",
	reglamento: "reglamentos",
};

export function rankToFolder(rank: Rank): string {
	return RANK_FOLDERS[rank] ?? "otros";
}

export function normToFilepath(metadata: NormMetadata): string {
	const folder = rankToFolder(metadata.rank);
	return `${folder}/${metadata.id}.md`;
}
