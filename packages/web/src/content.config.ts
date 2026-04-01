import { defineCollection, z } from "astro:content";
import { lawsLoader } from "./loaders/laws.ts";

const lawsPath = process.env.LAWS_PATH ?? "../../content/laws";

const laws = defineCollection({
	loader: lawsLoader({ path: lawsPath }),
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
