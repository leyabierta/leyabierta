import { hydeRewrite } from "./hyde-rewrite.ts";

const apiKey = process.env.HERMES_API_KEY!;
const queries = [
	"el vecino de arriba hace mucho ruido por la noche",
	"denunciar a mi marido por malos tratos",
	"ha muerto mi padre cómo se reparte la herencia",
	"hacer testamento dejar mis cosas a mis hijos",
	"atropellé a alguien sin querer",
];

for (const q of queries) {
	const start = Date.now();
	const rewrite = await hydeRewrite(apiKey, q);
	const ms = Date.now() - start;
	console.log(`\nQ: ${q}`);
	console.log(`R (${ms}ms): ${rewrite}`);
}
