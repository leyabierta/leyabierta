/**
 * Alert/newsletter endpoints: profiles, subscribe, confirm, unsubscribe.
 */

import { Elysia, t } from "elysia";
import { getProfileById, PROFILES } from "../data/profiles.ts";
import type { DbService } from "../services/db.ts";
import { sendConfirmationEmail } from "../services/email.ts";

export function alertRoutes(dbService: DbService) {
	return new Elysia({ prefix: "/v1" })
		.get("/profiles", () => {
			return {
				data: PROFILES.map((p) => ({
					id: p.id,
					name: p.name,
					description: p.description,
					icon: p.icon,
				})),
			};
		})

		.post(
			"/alerts/subscribe",
			async ({ body, set }) => {
				const profile = getProfileById(body.profileId);
				if (!profile) {
					set.status = 400;
					return { error: "Perfil no encontrado" };
				}

				const token = crypto.randomUUID();
				const added = dbService.addSubscriber(
					body.email,
					body.profileId,
					body.jurisdiction,
					token,
				);

				if (!added) {
					set.status = 409;
					return { error: "Ya estas suscrito a este perfil" };
				}

				await sendConfirmationEmail(body.email, token, profile.name);

				return {
					ok: true,
					message: "Revisa tu email para confirmar la suscripcion",
				};
			},
			{
				body: t.Object({
					email: t.String({ format: "email" }),
					profileId: t.String(),
					jurisdiction: t.String(),
				}),
			},
		)

		.get(
			"/alerts/confirm/:token",
			({ params, set }) => {
				const confirmed = dbService.confirmSubscriber(params.token);
				if (!confirmed) {
					set.status = 404;
					return { error: "Enlace no valido o ya confirmado" };
				}
				return { ok: true, message: "Suscripcion confirmada" };
			},
			{
				params: t.Object({ token: t.String() }),
			},
		)

		.get(
			"/alerts/unsubscribe/:token",
			({ params, set }) => {
				const removed = dbService.removeSubscriber(params.token);
				if (!removed) {
					set.status = 404;
					return { error: "Suscripcion no encontrada" };
				}
				return { ok: true, message: "Suscripcion cancelada" };
			},
			{
				params: t.Object({ token: t.String() }),
			},
		);
}
