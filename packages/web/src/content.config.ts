import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const laws = defineCollection({
	loader: glob({
		pattern: "**/*.md",
		base: "../../content/laws",
		retainBody: false,
	}),
	schema: z.object({
		titulo: z.string(),
		identificador: z.string(),
		pais: z.string(),
		jurisdiccion: z.string(),
		rango: z.string(),
		fecha_publicacion: z.string(),
		ultima_actualizacion: z.string(),
		estado: z.string(),
		departamento: z.string(),
		fuente: z.string(),
		pdf: z.string().optional(),
	}),
});

export const collections = { laws };
