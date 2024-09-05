import { Elysia, t } from "elysia";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import type { CookieDoc, UserData } from "../utils";

export const authenticationHandlers = (config: AppConfig) =>
	new Elysia({
		name: "authenticationHandlers",
	})
		.use(setup(config.mongourl))
		.post(
			"/login",
			async ({ body, set, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const col = db.collection<UserData>("authentication");
					const doc = await col.findOne({ email: body.email });

					if (doc === null) {
						set.status = "Not Found";
						return;
					}

					// Hash here
					if (await Bun.password.verify(body.password, doc.passwordHash)) {
						const uuid = crypto.randomUUID();

						const col2 = db.collection<CookieDoc>("cookies");
						await col2.insertOne({ email: body.email, cookie: uuid });

						const date = new Date(Date.now());
						date.setDate(date.getDate() + 3);

						set.headers["Set-Cookie"] =
							`session-id=${uuid}; Expires=${date.toUTCString()}`;

						return;
					}

					set.status = "Unauthorized";
				} catch (err) {
					console.error("Error: ", err);

					set.status = "Internal Server Error";
				}
			},
			{
				body: t.Object({
					email: t.String(),
					password: t.String(),
					rememberMe: t.Optional(t.String()),
				}),
			},
		)
		.post(
			"/signup",
			async ({ body, set, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const col = db.collection<UserData>("authentication");

					if (await col.findOne({ email: body.email })) {
						set.status = "Conflict";

						return;
					}

					await col.insertOne({
						email: body.email,
						name: body.name,
						avatarLink: "",
						passwordHash: await Bun.password.hash(body.password),
						uploadedInstructions: [],
						uploadedRigTracks: [],
						uploadedModels: [],
					});
					const uuid = crypto.randomUUID();

					const col2 = db.collection("cookies");
					await col2.insertOne({ email: body.email, cookie: uuid });

					set.headers["Set-Cookie"] = `session-id=${uuid}`;

					set.status = "Created";
				} catch (err) {
					console.error("Error: ", err);

					set.status = "Internal Server Error";
				}
			},
			{
				body: t.Object({
					email: t.String(),
					name: t.String(),
					password: t.String(),
				}),
			},
		)
		.get("/auth", async ({ set, cookie, mongo }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			try {
				const db = mongo.db("setup3d");
				const col = db.collection<CookieDoc>("cookies");
				const doc = await col.findOne({ cookie: sessionId.value });

				if (doc) {
					return { email: doc.email };
				}
				console.log(doc);

				set.status = "Unauthorized";
				return;
			} catch (err) {
				console.error(err);

				set.status = "Internal Server Error";
				return;
			}
		})
		.delete("/logout", async ({ set, cookie, mongo }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}
			try {
				const db = mongo.db("setup3d");
				const col = db.collection<CookieDoc>("cookies");

				const doc = await col.deleteOne({ cookie: sessionId.value });

				if (doc.deletedCount === 1) {
					set.headers["Set-Cookie"] =
						"session-id=; Expires=Thu, 01 Jan 1970 00:00:00 GMT";

					return;
				}

				set.status = "Bad Request";
				return;
			} catch (err) {
				console.error(err);

				set.status = "Internal Server Error";
				return;
			}
		})
		.get("/userData", async ({ set, mongo, cookie }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			try {
				const db = mongo.db("setup3d");
				const cookiesCol = db.collection<CookieDoc>("cookies");
				const doc = await cookiesCol.findOne({ cookie: sessionId.value });

				if (doc) {
					const userCol = db.collection<UserData>("authentication");
					const user = await userCol.findOne({ email: doc.email });

					if (user) {
						return {
							name: user.name,
							email: user.email,
							avatarLink: user.avatarLink,
							uploadedInstructions: user.uploadedInstructions,
							uploadedRigTracks: user.uploadedRigTracks,
							uploadedModels: user.uploadedModels,
							cameras: user.cameras,
						};
					}

					set.status = "Not Found";
				}

				set.status = "Unauthorized";
				return;
			} catch (err) {
				console.error(err);

				set.status = "Internal Server Error";
				return;
			}
		});
