import { access } from "node:fs/promises";

import { Elysia, t } from "elysia";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import {
	type CookieDoc,
	type UserData,
	authenticate,
	handleAuthError,
} from "../utils";

export const characterModelHandlers = (config: AppConfig) =>
	new Elysia({
		name: "characterModelHandlers",
	})
		.use(setup(config.mongourl))
		.post(
			"/change-model",
			async ({ set, body, cookie, mongo }) => {
				// Should delete the old model I guess?

				const [userDoc, err] = await authenticate(cookie, mongo);
				if (err) {
					handleAuthError(err, set);
					return;
				}

				const uuid = crypto.randomUUID();

				try {
					await Bun.write(
						`${config.datapath}/rigModels/${uuid}.glb`,
						body["model-file"],
					);

					const db = mongo.db("setup3d");
					const userCol = db.collection<UserData>("authentication");

					const result = await userCol.updateOne(userDoc, {
						$set: { selectedRigModel: { id: uuid, name: body.name } },
					});
					if (result.modifiedCount === 1) {
						console.log(
							`Successfully update the rig model of ${userDoc.email}`,
						);

						return;
					}

					set.status = "Internal Server Error";

					return;
				} catch (err) {
					console.error(err);

					set.status = "Internal Server Error";

					return;
				}
			},
			{
				body: t.Object({
					"model-file": t.File(),
					name: t.String(),
				}),
			},
		)
		.get("/current-model", async ({ set, cookie, mongo }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			try {
				const db = mongo.db("setup3d");
				const cookiesCol = db.collection<CookieDoc>("cookies");
				const authDoc = await cookiesCol.findOne({
					cookie: sessionId.value,
				});

				if (!authDoc) {
					set.status = "Unauthorized";
					return;
				}

				const userCol = db.collection<UserData>("authentication");
				const userDoc = await userCol.findOne({ email: authDoc.email });

				if (!userDoc) {
					set.status = "Internal Server Error";
					return;
				}

				if (!userDoc.selectedRigModel) {
					return Bun.file(`${config.datapath}/rigModels/default.glb`);
				}

				try {
					await access(
						`${config.datapath}/rigModels/${userDoc.selectedRigModel.id}.glb`,
					);
				} catch (e) {
					console.error(`${userDoc.selectedRigModel} is not accessible`);

					set.status = "Internal Server Error";
					return;
				}

				return Bun.file(
					`${config.datapath}/rigModels/${userDoc.selectedRigModel.id}.glb`,
				);
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		.get("/current-model-name", async ({ cookie, set, mongo }) => {
			const [userDoc, err] = await authenticate(cookie, mongo);
			if (err) {
				handleAuthError(err, set);
				return;
			}

			if (!userDoc.selectedRigModel) {
				set.status = "Bad Request";

				return;
			}

			return userDoc.selectedRigModel.name;
		});
