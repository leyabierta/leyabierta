import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCollection, z } from "astro:content";
import { lawsLoader } from "./loaders/laws.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lawsPath = resolve(rootDir, process.env.LAWS_PATH ?? "../leyes");

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
		articulos: z.number().optional().default(0),
		reformas: z
			.array(z.object({ fecha: z.string(), fuente: z.string() }))
			.optional()
			.default([]),
		materias: z.array(z.string()).optional().default([]),
		notas: z.array(z.string()).optional().default([]),
		referencias_anteriores: z
			.array(
				z.object({
					norma: z.string(),
					relacion: z.string(),
					texto: z.string(),
				}),
			)
			.optional()
			.default([]),
		referencias_posteriores: z
			.array(
				z.object({
					norma: z.string(),
					relacion: z.string(),
					texto: z.string(),
				}),
			)
			.optional()
			.default([]),
	}),
});

export const collections = { laws };
