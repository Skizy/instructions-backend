import { $ } from "bun";

import { access } from "node:fs/promises";

import { type Cookie, Elysia, t } from "elysia";
import { Long, type MongoClient, ObjectId } from "mongodb";

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
				.get("/", ({ cookie, mongo, set }) => {
					return requestResourceList({
						collection: "rig_tracks",
						cookie,
						mongo,
						set,
					});
				})
				.get("/:id", ({ cookie, mongo, params: { id }, set }) => {
					return requestResource({
						cookie,
						id,
						mongo,
						resourcePath: `${config.datapath}/rigTracks`,
						set,
						userProperty: "uploadedRigTracks",
					});
				})
				.post(
					"/",
					({ body, cookie, mongo, set }) => {
						return createResource({
							collection: "rig_tracks",
							cookie,
							mongo,
							newResource: body.rigTrack,
							newResourceName: body.name,
							resourcePath: `${config.datapath}/rigTracks`,
							set,
							userProperty: "uploadedRigTracks",
						});
					},
					{
						body: t.Object({
							name: t.String(),
							rigTrack: t.Union([t.File(), t.String()]),
						}),
					},
				)
				.delete("/:id", ({ cookie, mongo, params: { id }, set }) => {
					return deleteResource({
						collection: "rig_tracks",
						cookie,
						id,
						mongo,
						resourcePath: `${config.datapath}/rigTracks`,
						set,
						trashPath: `${config.datapath}/trash`,
						userProperty: "uploadedRigTracks",
					});
				}),
		)
		.group("/models", (app) =>
			app
				.get("/", ({ cookie, mongo, set }) => {
					return requestResourceList({
						collection: "models",
						cookie,
						mongo,
						set,
					});
				})
				.get("/:id", ({ cookie, mongo, params: { id }, set }) => {
					return requestResource({
						cookie,
						id,
						mongo,
						resourcePath: `${config.datapath}/models`,
						set,
						userProperty: "uploadedModels",
					});
				})
				.post(
					"/",
					({ body, cookie, mongo, set }) => {
						return createResource({
							collection: "models",
							cookie,
							mongo,
							newResource: body.model,
							newResourceName: body.name,
							resourcePath: `${config.datapath}/models`,
							set,
							userProperty: "uploadedModels",
						});
					},
					{
						body: t.Object({
							name: t.String(),
							model: t.Union([t.File(), t.String()]),
						}),
					},
				)
				.delete("/:id", ({ cookie, mongo, params: { id }, set }) => {
					return deleteResource({
						collection: "models",
						cookie,
						id,
						mongo,
						resourcePath: `${config.datapath}/models`,
						set,
						trashPath: `${config.datapath}/trash`,
						userProperty: "uploadedModels",
					});
				}),
		);

type Resource = {
	name: string;
	date: number | Long;
	uploader: string;
	deleted: boolean;
};

async function requestResourceList({
	collection,
	cookie,
	mongo,
	set,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	mongo: MongoClient;
	set: { status?: undefined | number | string };
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");

	const resourceCollection = db.collection<Resource>(collection);

	const resourceList = await resourceCollection
		.find({ uploader: userDoc._id.toHexString(), deleted: false })
		.toArray();

	return resourceList;
}

async function requestResource({
	cookie,
	id,
	mongo,
	resourcePath,
	set,
	userProperty,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	id: string;
	mongo: MongoClient;
	resourcePath: string;
	set: { status?: undefined | number | string };
	userProperty: "uploadedRigTracks" | "uploadedModels";
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	if (!userDoc[userProperty].includes(id)) {
		set.status = "Unauthorized";

		return;
	}

	const filePath = `${resourcePath}/${id}.json`;

	try {
		await access(filePath);
	} catch (e) {
		console.error(`${filePath} is not accessible`);

		set.status = "Internal Server Error";

		return;
	}

	return Bun.file(filePath);
}

async function createResource({
	collection,
	cookie,
	mongo,
	newResource,
	newResourceName,
	resourcePath,
	set,
	userProperty,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	mongo: MongoClient;
	newResource: string | File;
	newResourceName: string;
	resourcePath: string;
	set: { status?: undefined | number | string };
	userProperty: "uploadedRigTracks" | "uploadedModels";
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");
	const userCollection = db.collection<UserData>("authentication");

	const resourceCollection = db.collection<Resource>(collection);

	const date = new Long(BigInt(Date.now()));

	const result = await resourceCollection.insertOne({
		name: newResourceName,
		uploader: userDoc._id.toHexString(),
		date,
		deleted: false,
	});

	if (result.insertedId !== null) {
		const id = result.insertedId.toHexString();

		await Bun.write(`${resourcePath}/${id}.json`, newResource);

		await userCollection.updateOne(
			{ _id: userDoc._id },
			{ $addToSet: { [userProperty]: id } },
		);
	} else {
		throw new Error("Didn't get the id of the inserted document");
	}

	set.status = "Created";
}

async function deleteResource({
	collection,
	cookie,
	id,
	mongo,
	resourcePath,
	set,
	trashPath,
	userProperty,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	id: string;
	mongo: MongoClient;
	resourcePath: string;
	set: { status?: undefined | number | string };
	trashPath: string;
	userProperty: "uploadedRigTracks" | "uploadedModels";
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");

	const usersCollection = db.collection<UserData>("authentication");
	const resourceCollection = db.collection<Resource>(collection);

	await usersCollection.updateOne(
		{ _id: userDoc._id },
		{ $pull: { [userProperty]: id } },
	);

	await resourceCollection.updateOne(
		{ _id: ObjectId.createFromHexString(String(id)) },
		{
			$set: { deleted: true },
		},
	);

	const filePath = `${resourcePath}/${id}.json`;

	try {
		await access(filePath);
	} catch (e) {
		console.error(`${filePath} is not accessible`);

		set.status = "Internal Server Error";

		return;
	}

	await $`mv ${filePath} ${trashPath}`;
}
