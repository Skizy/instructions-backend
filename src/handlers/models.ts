import { $ } from "bun";

import { access } from "node:fs/promises";

import { Elysia, t } from "elysia";
import { Long, ObjectId } from "mongodb";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import {
	type CookieDoc,
	type UserData,
	authenticate,
	handleAuthError,
} from "../utils";

type RigTrack = {
	name: string;
	date: number | Long;
	uploader: string;
	deleted: boolean;
};

// type Model = {
// 	name: string;
// 	date: number | Long;
// 	uploader: string;
// };

export const modelsHandlers = (config: AppConfig) =>
	new Elysia({
		name: "modelsHandlers",
	})
		.use(setup(config.mongourl))
		.post(
			"/uploadRigData",
			async ({ body, set, cookie, mongo }) => {
				const sessionId = cookie["session-id"];
				if (!sessionId.value) {
					set.status = "Unauthorized";
					return;
				}
				console.dir(body);

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

					const col = db.collection<RigTrack>("rigdata");

					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						name: body.name,
						uploader: userDoc._id.toHexString(),
						date,
						deleted: false,
					});

					if (result.insertedId !== null) {
						console.log("Writing the file");
						const id = result.insertedId.toHexString();

						await Bun.write(`${config.datapath}/rigData/${id}.json`, body.file);

						await userCol.updateOne(
							{ _id: userDoc._id },
							{ $addToSet: { uploadedRigDataList: id } },
						);
					} else {
						throw new Error("Didn't get the id of the inserted document");
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";
					return;
				}

				set.status = "Created";
				return;
			},
			{ body: t.Object({ name: t.String(), file: t.File() }) },
		)
		.get("/rigData", async ({ set, cookie, mongo }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			console.log("Responding with rigData");

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

				const col = db.collection<RigTrack>("rigdata");

				const results = await col
					.find({ uploader: userDoc._id.toHexString() })
					.map((doc) => ({
						id: doc._id.toHexString(),
						name: doc.name,
						date: doc.date,
					}))
					.toArray();

				return results;
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		.get("/rigData/:id", async ({ params: { id }, set, mongo }) => {
			try {
				const db = mongo.db("setup3d");
				const col = db.collection<RigTrack>("rigdata");

				const result = await col.findOne({ _id: new ObjectId(id) });

				if (!result) {
					set.status = "Bad Request";
					return;
				}

				return Bun.file(`${config.datapath}/rigData/${id}.json`);
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		.group("/rigTracks", (app) =>
			app
				.get("/", async ({ cookie, mongo, set }) => {
					const [userDoc, err] = await authenticate(cookie, mongo);

					if (err) {
						handleAuthError(err, set);
						return;
					}

					const db = mongo.db("setup3d");

					const rigTracksCollection = db.collection<RigTrack>("rig_tracks");

					const rigTracks = await rigTracksCollection
						.find({ uploader: userDoc._id.toHexString(), deleted: false })
						.toArray();

					return rigTracks;
				})
				.get("/:id", async ({ cookie, mongo, params: { id }, set }) => {
					const [userDoc, err] = await authenticate(cookie, mongo);

					if (err) {
						handleAuthError(err, set);
						return;
					}

					if (!userDoc.uploadedRigTracks.includes(id)) {
						set.status = "Unauthorized";

						return;
					}

					const filePath = `${config.datapath}/rigTracks/${id}.json`;

					try {
						await access(filePath);
					} catch (e) {
						console.error(`${filePath} is not accessible`);

						set.status = "Internal Server Error";

						return;
					}

					return Bun.file(filePath);
				})
				.post(
					"/",
					async ({ body, cookie, mongo, set }) => {
						const [userDoc, err] = await authenticate(cookie, mongo);

						if (err) {
							handleAuthError(err, set);
							return;
						}

						const db = mongo.db("setup3d");
						const userCollection = db.collection<UserData>("authentication");

						const rigTracksCollection = db.collection<RigTrack>("rig_tracks");

						const date = new Long(BigInt(Date.now()));

						const result = await rigTracksCollection.insertOne({
							name: body.name,
							uploader: userDoc._id.toHexString(),
							date,
							deleted: false,
						});

						if (result.insertedId !== null) {
							const id = result.insertedId.toHexString();

							await Bun.write(
								`${config.datapath}/rigTracks/${id}.json`,
								body.rigTrack,
							);

							await userCollection.updateOne(
								{ _id: userDoc._id },
								{ $addToSet: { uploadedRigTracks: id } },
							);
						} else {
							throw new Error("Didn't get the id of the inserted document");
						}

						set.status = "Created";
					},
					{
						body: t.Object({
							name: t.String(),
							rigTrack: t.Union([t.File(), t.String()]),
						}),
					},
				)
				.delete("/:id", async ({ cookie, mongo, params: { id }, set }) => {
					const [userDoc, err] = await authenticate(cookie, mongo);

					if (err) {
						handleAuthError(err, set);
						return;
					}

					const db = mongo.db("setup3d");

					const usersCollection = db.collection<UserData>("authentication");
					const rigTracksCollection = db.collection<RigTrack>("rig_tracks");

					await usersCollection.updateOne(
						{ _id: userDoc._id },
						{ $pull: { uploadedRigTracks: id } },
					);

					await rigTracksCollection.updateOne(
						{ _id: ObjectId.createFromHexString(String(id)) },
						{
							$set: { deleted: true },
						},
					);

					const filePath = `${config.datapath}/rigTracks/${id}.json`;

					try {
						await access(filePath);
					} catch (e) {
						console.error(`${filePath} is not accessible`);

						set.status = "Internal Server Error";

						return;
					}

					await $`mv ${filePath} ${config.datapath}/trash`;
				}),
		)
		.group("/models", (app) =>
			app
				.get("/", () => {})
				.get("/:id", ({ params: { id } }) => {})
				.post("/", () => {})
				.delete("/:id", ({ params: { id } }) => {}),
		);
