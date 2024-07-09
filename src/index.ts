import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";

import { Stream } from "@elysiajs/stream";
import { type Cookie, Elysia, type Static, t } from "elysia";
import { TypeCompiler } from "elysia/type-system";

import { Long, MongoClient, ObjectId } from "mongodb";

import { $ } from "bun";

import {
	CameraState,
	type CameraStreamMessageT,
	CameraStreamMessageType,
	ClientMessage,
	ClientMessageType,
	type ServerMessage,
	ServerMessageType,
} from "custom-types";

type Model = {
	name: string;
	manufacturer: string;
	date: number | Long;
	fileName: string;
	uploader: string;
	hidden?: boolean;
};

type RigData = {
	name: string;
	date: number | Long;
	uploader: string;
};

type UserData = {
	email: string;
	name: string;
	avatarLink: string;
	passwordHash: string;
	uploadedModels: string[];
	uploadedRigDataList: string[];
	selectedRigModel?: { id: string; name: string };
	cameras?: string[];
};

type CookieDoc = {
	email: string;
	cookie: string;
};

/** Status:
 *  0 - inactive
 *  1 - active
 *  2 - used */
type ExternalCamera = {
	uuid: string;
	expires: number;
	status: CameraState;
	userAgent: string | null;
};

const ClientMessageCompiled = TypeCompiler.Compile(ClientMessage);

type CameraStream = {
	raw: Stream<string>;
	send: (val: CameraStreamMessageT) => void;
	intervalId: Timer;
};

async function main() {
	/** @returns `boolean` - sent successfully */
	function sendToSocket(uuid: string, message: Static<typeof ServerMessage>) {
		return (app.server?.publish(uuid, JSON.stringify(message)) ?? 0) > 0;
	}

	const config = await loadConfig();

	const app = new Elysia()
		// .use(cors())
		.decorate("camStreams", new Map<string, CameraStream>())
		.decorate("mongo", new MongoClient(config.mongourl))
		.decorate("timeouts", new Map<string, { reset: boolean; timer: Timer }>())
		// /ping
		.get("/ping", () => "pong")
		// /room.json
		.get("/room.json", async () => {
			let room: unknown;
			try {
				room = await Bun.file(`${config.datapath}/rooms/room.json`).json();
			} catch (err) {
				console.error(err);
				room = {};
			}

			return room;
		})
		// /modelList
		.get("/modelList", async ({ set, headers, mongo }) => {
			try {
				const db = mongo.db("setup3d");
				const col = db.collection<Model>("devcollection");
				const cur = col.find({ hidden: { $not: { $eq: true } } });
				const docs: {
					id: string;
					name: string;
					date: number;
					manufacturer: string;
				}[] = [];
				for await (const doc of cur) {
					const id = doc._id.toHexString();

					try {
						access(`${config.datapath}/models/${id}/${doc.fileName}`);
					} catch (e) {
						console.error(`${doc.name} at ${doc.fileName} is not accessible`);
						continue;
					}

					docs.push({
						id,
						name: doc.name,
						date: doc.date as number,
						manufacturer: doc.manufacturer,
					});
				}

				console.debug("Returning modelList to request with headers:");
				console.debug(headers);

				return docs;
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		// /models/:model
		.get(
			"/models/:model",
			async ({ params: { model }, set, mongo }) => {
				const id = new ObjectId(model);

				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("devcollection");

					const doc = await col.findOne({ _id: id });
					if (doc !== null) {
						const fileName = doc.fileName;

						const assetsPath = `${config.datapath}/models/${model}/deps`;
						let files: Dirent[];
						try {
							files = (
								await readdir(assetsPath, {
									recursive: true,
									withFileTypes: true,
								})
							).filter((x) => !x.isDirectory());
						} catch (e) {
							console.log(
								"Directory with assets for this model doesn't exist:",
								e,
							);
							files = [];
						}

						const fd = new FormData();
						fd.append(
							"file",
							Bun.file(`${config.datapath}/models/${model}/${fileName}`),
						);
						fd.append("fileName", fileName);

						for (const file of files) {
							const name = file.name;
							fd.append(name, Bun.file(`${assetsPath}/${name}`));
						}

						let response: Response;
						try {
							response = new Response(fd);
						} catch (e) {
							console.error(`Couldn't create response: ${e}`);
							set.status = "Internal Server Error";
							return;
						}

						return response;
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";
					return;
				}

				set.status = "Not Found";
				return;
			},
			{
				params: t.Object({ model: t.String() }),
				type: "multipart/form-data",
			},
		)
		// /models
		.post(
			"/models",
			async ({ body, cookie, set, mongo }) => {
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

					const col = db.collection<Model>("devcollection");

					const fileName = body.file.name;
					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						fileName,
						name: body.modelName,
						manufacturer: body.manufacturer,
						date,
						// uploader: "",
						uploader: userDoc._id.toHexString(),
					});

					if (result.insertedId !== null) {
						console.log(
							"Writing the file and extracting files from the archive",
						);
						const id = result.insertedId.toHexString();

						console.log("creating a dir");
						await $`mkdir -p ${config.datapath}/models/${id}/deps`;
						console.log("created a dir");

						await Bun.write(
							`${config.datapath}/models/${id}/${fileName}`,
							body.file,
						);

						console.debug(body.assets);

						if (body.assets !== undefined && body.assets.type.length > 0) {
							const workingDirectory = await $`pwd`.text();
							$.cwd(`${config.datapath}/models/${id}/deps`);
							if (
								body.assets.type === "application/gzip" ||
								body.assets.type === "application/x-tar"
							) {
								const tmpFile = Bun.file(
									`${config.datapath}/models/${id}/.tmp.tar.gz`,
								);
								await Bun.write(tmpFile, body.assets);
								await $`tar -xf ../.tmp.tar.gz`;
								await $`rm ../.tmp.tar.gz`;
							} else if (body.assets.type === "application/zip") {
								const tmpFile = Bun.file(
									`${config.datapath}/models/${id}/.tmp.zip`,
								);
								await Bun.write(tmpFile, body.assets);
								await $`bsdtar -xf ../.tmp.zip`;
								await $`rm ../.tmp.zip`;
							} else {
								console.error("Unknown assets file type: ", body.assets.type);
							}

							$.cwd(workingDirectory);
						}

						await userCol.updateOne(
							{ _id: userDoc._id },
							{ $addToSet: { uploadedModels: id } },
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
			{
				body: t.Object({
					file: t.File(),
					assets: t.Optional(t.File()),
					manufacturer: t.String(),
					modelName: t.String(),
				}),
			},
		)
		// /models/:id
		.delete(
			"/models/:id",
			async ({ params: { id }, set, body, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const cookiesCol = db.collection<CookieDoc>("cookies");
					const doc = await cookiesCol.findOne({ cookie: body.sessionId });

					if (!doc) {
						set.status = "Unauthorized";
						return;
					}

					const userCol = db.collection<UserData>("authentication");
					const user = await userCol.findOne({ email: doc.email });

					if (!user || !user.uploadedModels.includes(id)) {
						set.status = "Unauthorized";
						return;
					}

					const modelCol = db.collection<Model>("devcollection");

					const { exitCode, stderr } =
						await $`mv ${config.datapath}/models/${id} ${config.datapath}/trash`.quiet();
					if (exitCode !== 0) {
						throw new Error(
							`Process exited with code ${exitCode}. stderr: ${String.fromCharCode(
								...stderr,
							)}`,
						);
					}

					const result = await modelCol.deleteOne({
						_id: ObjectId.createFromHexString(id),
					});
					if (result.deletedCount !== 1) {
						throw "Failed to delete the model document from the database";
					}

					const result2 = await userCol.updateOne(
						{ _id: user._id },
						{ $pull: { uploadedModels: id } },
					);
					if (result2.modifiedCount !== 1) {
						throw "Failed to remove the model id from the user's document";
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";

					return;
				}
			},
			{
				body: t.Object({ sessionId: t.String() }),
			},
		)
		// /:asset
		.get("/:asset", async ({ params: { asset }, set }) => {
			const file = Bun.file(`./frontend/${asset}`);
			if (await file.exists()) {
				return file;
			}

			set.status = "Not Found";
			return "Not found";
		})
		// /login
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
		// /signup
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
						uploadedModels: [],
						uploadedRigDataList: [],
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
		// /auth
		.post(
			"/auth",
			async ({ body, set, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const col = db.collection<CookieDoc>("cookies");
					const doc = await col.findOne({ cookie: body.sessionId });

					if (doc) {
						return { email: doc.email };
					}

					set.status = "Unauthorized";
					return;
				} catch (err) {
					console.error(err);

					set.status = "Internal Server Error";
					return;
				}
			},
			{
				body: t.Object({
					sessionId: t.String(),
				}),
			},
		)
		// /logout
		.delete(
			"/logout",
			async ({ body, set, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const col = db.collection<CookieDoc>("cookies");

					const doc = await col.deleteOne({ cookie: body.sessionId });
					// const doc = await col.findOne({ cookie: body.sessionId });

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
			},
			{
				body: t.Object({
					sessionId: t.String(),
				}),
			},
		)
		// /userData
		.get("/userData", async ({ set, mongo, cookie }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			try {
				const db = mongo.db("setup3d");
				const cookiesCol = db.collection<CookieDoc>("cookies");
				const doc = await cookiesCol.findOne({ cookie: sessionId });

				if (doc) {
					const userCol = db.collection<UserData>("authentication");
					const user = await userCol.findOne({ email: doc.email });

					if (user) {
						return {
							name: user.name,
							email: user.email,
							avatarLink: user.avatarLink,
							uploadedModels: user.uploadedModels,
							uploadedRigDataList: user.uploadedRigDataList,
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
		})
		// /modelData
		.post(
			"/modelData",
			async ({ set, body, mongo }) => {
				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("devcollection");
					const data = await col
						.find({
							_id: { $in: body.ids.map((x) => new ObjectId(x)) },
						})
						.map((doc) => ({
							modelName: doc.name,
							manufacturer: doc.manufacturer,
							createdOn: doc.date,
							id: doc._id.toHexString(),
						}))
						.toArray();

					return data;
				} catch (e) {
					console.error(e);

					set.status = "Internal Server Error";
					return;
				}
			},
			{
				body: t.Object({ ids: t.Array(t.String()) }),
			},
		)
		// /search
		.post(
			"/search",
			async ({ body, set, mongo }) => {
				const q = body.query;

				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("devcollection");
					const res = await col
						.find({
							$or: [
								{ name: { $regex: q, $options: "i" } },
								{ manufacturer: { $regex: q, $options: "i" } },
								{ uploader: { $regex: q, $options: "i" } },
							],
							hidden: { $not: { $eq: true } },
						})
						.limit(10)
						.toArray();

					return res;
				} catch (e) {
					set.status = "Internal Server Error";
					return;
				}
			},
			{
				body: t.Object({ query: t.String() }),
			},
		)
		// /uploadRigData
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

					const col = db.collection<RigData>("rigdata");

					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						name: body.name,
						uploader: userDoc._id.toHexString(),
						date,
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
		// /rigData
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

				const col = db.collection<RigData>("rigdata");

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
		// /rigData/:id
		.get("/rigData/:id", async ({ params: { id }, set, mongo }) => {
			try {
				const db = mongo.db("setup3d");
				const col = db.collection<RigData>("rigdata");

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
		// /change-model
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
		// /current-model
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
					access(
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
		})
		.get("/generate-external-camera-id", async ({ set, cookie, mongo }) => {
			const [doc, err] = await authenticate(cookie, mongo);
			if (err) {
				handleAuthError(err, set);

				return;
			}

			const uuid = crypto.randomUUID();
			const expires = Date.now() + 24 * 60 * 60 * 1000;

			const db = mongo.db("setup3d");

			const userCol = db.collection<UserData>("authentication");
			const result = await userCol.updateOne(
				{ _id: { $eq: doc._id } },
				{ $addToSet: { cameras: uuid } },
			);

			if (result.modifiedCount !== 1) {
				set.status = "Internal Server Error";

				return;
			}

			const cameraCol = db.collection<ExternalCamera>("cameras");
			const camResult = await cameraCol.insertOne({
				uuid,
				expires,
				status: CameraState.Uninitialized,
				userAgent: null,
			});

			if (!camResult.acknowledged) {
				await userCol.updateOne(
					{ _id: { $eq: doc._id } },
					{ $pull: { cameras: { uuid } } },
				);

				set.status = "Internal Server Error";

				return;
			}

			return uuid;
		})
		.get("/external-cameras", async ({ set, cookie, mongo, camStreams }) => {
			const [doc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);

				return;
			}

			const db = mongo.db("setup3d");
			const col = db.collection<ExternalCamera>("cameras");
			const result = col.find({
				uuid: { $in: doc.cameras },
			});

			const filtered: ExternalCamera[] = [];
			const now = Date.now();
			for await (const cam of result) {
				if (cam.expires < now) {
					col.deleteOne({ _id: cam._id });

					const stream = camStreams.get(doc._id.toHexString());
					if (stream) {
						stream.send({
							type: CameraStreamMessageType.Delete,
							uuid: cam.uuid,
						});
					}
				} else {
					filtered.push(cam);
				}
			}

			return filtered;
		})
		.get("/cameras-stream", async ({ set, cookie, mongo, camStreams }) => {
			const [doc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);

				return;
			}

			const stream = new Stream<string>();
			stream.event = "message";

			const send = (val: CameraStreamMessageT) =>
				stream.send(JSON.stringify(val));

			send({ type: CameraStreamMessageType.Ping });

			const timer = setInterval(() => {
				send({ type: CameraStreamMessageType.Ping });
			}, 2000);

			const cameraStream: CameraStream = {
				raw: stream,
				send,
				intervalId: timer,
			};

			camStreams.set(doc._id.toHexString(), cameraStream);

			console.log(`Creating a stream of ${doc.email}`);

			return stream;
		})
		.get("/close-stream", async ({ set, cookie, mongo, camStreams }) => {
			const [doc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);

				return;
			}

			console.log(`Closing stream of ${doc.email}`);

			camStreams.delete(doc._id.toHexString());
		})
		.post(
			"/start-cameras",
			async ({ set, cookie, mongo, body }) => {
				const [doc, err] = await authenticate(cookie, mongo);

				if (err) {
					handleAuthError(err, set);

					return;
				}

				const ids = body.ids;

				if (ids.some((cam) => !(doc.cameras?.includes(cam) ?? false))) {
					set.status = "Unauthorized";

					return;
				}

				const db = mongo.db("setup3d");
				const col = db.collection<ExternalCamera>("cameras");
				const toEnable = await col.find({ uuid: { $in: ids } }).toArray();

				if (toEnable.some((x) => x.status !== 1)) {
					set.status = "Bad Request";

					return;
				}

				for (let i = 0; i < ids.length; i += 1) {
					const result = sendToSocket(ids[i], {
						type: ServerMessageType.Start,
						fps: body.fps,
					});

					if (!result) {
						for (let j = 0; j < i; j += 1) {
							sendToSocket(ids[j], {
								type: ServerMessageType.Stop,
								sendVideo: false,
							});
						}

						set.status = "Internal Server Error";

						return;
					}
				}

				col.updateMany({ uuid: { $in: ids } }, { $set: { status: 2 } });
			},
			{
				body: t.Object({ ids: t.Array(t.String()), fps: t.Number() }),
			},
		)
		.post("/stop-cameras", async ({ set, cookie, mongo }) => {
			const [doc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);

				return;
			}

			const db = mongo.db("setup3d");
			const col = db.collection<ExternalCamera>("cameras");

			const active = await col
				.find({ $and: [{ uuid: { $in: doc.cameras } }, { status: 2 }] })
				.toArray();

			for (const cam of active) {
				sendToSocket(cam.uuid, {
					type: ServerMessageType.Stop,
					sendVideo: true,
				});
			}

			await col.updateMany(
				{ uuid: { $in: active.map((x) => x.uuid) } },
				{ $set: { status: 1 } },
			);
		})
		.decorate("idToUUID", new Map<string, string>())
		.ws("/camera-socket", {
			async message(ws, message) {
				if (message instanceof Buffer) {
					console.log("Received a Buffer in the websocket:", message);

					return;
				}

				if (!ClientMessageCompiled.Check(message)) {
					return;
				}

				switch (message.type) {
					case ClientMessageType.UUID: {
						console.log("Opening message of uuid", message.uuid);

						const db = ws.data.mongo.db("setup3d");
						const col = db.collection<ExternalCamera>("cameras");
						const doc = await col.findOne({ uuid: message.uuid });

						if (doc === null || doc.status !== CameraState.Uninitialized) {
							const error = doc === null ? "NotFound" : "InUse";
							ws.send(
								JSON.stringify({
									type: ServerMessageType.UUIDConfirmation,
									success: false,
									error,
								} satisfies Static<typeof ServerMessage>),
							);
							ws.close();

							break;
						}

						await col.updateOne(
							{ _id: doc._id },
							{
								$set: {
									status: CameraState.Waiting,
									userAgent: message.userAgent,
								},
							},
						);

						const authCol = db.collection<UserData>("authentication");
						const result = await authCol.findOne({
							cameras: doc.uuid,
						});
						if (result) {
							const stream = ws.data.camStreams.get(result._id.toHexString());
							if (stream) {
								stream.send({
									type: CameraStreamMessageType.StateUpdate,
									uuid: doc.uuid,
									state: CameraState.Waiting,
									userAgent: message.userAgent,
								});
							}
						}

						ws.send(
							JSON.stringify({
								type: ServerMessageType.UUIDConfirmation,
								success: true,
							} satisfies Static<typeof ServerMessage>),
						);

						ws.data.idToUUID.set(ws.id, message.uuid);

						ws.subscribe(message.uuid);

						const timer = setInterval(() => {
							const timeout = ws.data.timeouts.get(ws.id);
							if (!timeout) {
								ws.close();
								clearInterval(timer);
								return;
							}

							if (timeout.reset) {
								timeout.reset = false;
							} else {
								console.log(
									`Lost connection to camera with id ${message.uuid}`,
								);
								ws.data.timeouts.delete(ws.id);
								ws.close();
								clearInterval(timeout.timer);
							}
						}, 5000);
						ws.data.timeouts.set(ws.id, {
							reset: false,
							timer,
						});

						break;
					}
					case ClientMessageType.StateUpdate: {
						const db = ws.data.mongo.db("setup3d");
						const col = db.collection<ExternalCamera>("cameras");

						col.updateOne(
							{ uuid: { $eq: message.uuid } },
							{ $set: { status: message.state } },
						);

						// Get the owner document id
						const authCol = db.collection<UserData>("authentication");
						const result = await authCol.findOne({
							cameras: message.uuid,
						});
						if (result) {
							const stream = ws.data.camStreams.get(result._id.toHexString());
							if (stream) {
								console.log("Sending state update for uuid", message.uuid);

								stream.send({
									type: CameraStreamMessageType.StateUpdate,
									uuid: message.uuid,
									state: message.state,
								});
							}
						}

						break;
					}
					case ClientMessageType.Free: {
						console.log("Free message:", message.message);
						break;
					}
					case ClientMessageType.ToggleResponse: {
						console.log("Camera toggle recording succeded:", message.success);
						break;
					}
					case ClientMessageType.Ping: {
						const timeout = ws.data.timeouts.get(ws.id);
						if (timeout) {
							timeout.reset = true;
						}

						ws.send(
							JSON.stringify({
								type: ServerMessageType.Pong,
							} satisfies Static<typeof ServerMessage>),
						);
						break;
					}
					case ClientMessageType.PoseData: {
						const data = message.data;

						console.log("Received Pose data");

						const cameraUUID = ws.data.idToUUID.get(ws.id);
						if (!cameraUUID) {
							break;
						}

						const userId = await camUUIDtoUserId(cameraUUID, ws.data.mongo);
						if (!userId) {
							break;
						}

						const stream = ws.data.camStreams.get(userId);
						if (!stream) {
							break;
						}

						stream.send({
							type: CameraStreamMessageType.ExternalPoseData,
							uuid: cameraUUID,
							data,
						});

						break;
					}
					default: {
						throw new Error(
							`Unknown message type of message: ${JSON.stringify(message satisfies never)}`,
						);
					}
				}
			},
			async close(ws, _code, _message) {
				const uuid = ws.data.idToUUID.get(ws.id);

				if (uuid) {
					const db = ws.data.mongo.db("setup3d");
					const col = db.collection<ExternalCamera>("cameras");
					col.updateOne(
						{ uuid },
						{
							$set: { status: CameraState.Uninitialized, userAgent: undefined },
						},
					);

					ws.data.idToUUID.delete(ws.id);

					const authCol = db.collection<UserData>("authentication");
					const result = await authCol.findOne({
						cameras: uuid,
					});
					if (result) {
						const stream = ws.data.camStreams.get(result._id.toHexString());
						if (stream) {
							stream.send({
								type: CameraStreamMessageType.StateUpdate,
								uuid,
								state: CameraState.Uninitialized,
							});
						}
					}
				}

				const timeout = ws.data.timeouts.get(ws.id);
				if (timeout) {
					clearInterval(timeout.timer);

					ws.data.timeouts.delete(ws.id);
				}
			},
		})
		.onError(({ code, error, set }) => {
			if (code === "VALIDATION") {
				set.status = "Bad Request";
			}
			console.error(error);
		})
		.listen(config.port);

	console.log(
		`Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
	);

	return app;
}

type AnyError = {
	code: number;
	message: string;
};

async function authenticate(
	// biome-ignore lint/suspicious/noExplicitAny: the function signature of elysia handler
	cookie: Record<string, Cookie<any>>,
	mongo: MongoClient,
) {
	const sessionId = cookie["session-id"];
	if (!sessionId.value) {
		return [null, { code: 0, message: "Unauthorized" } as AnyError] as const;
	}

	try {
		const db = mongo.db("setup3d");
		const cookiesCol = db.collection<CookieDoc>("cookies");
		const authDoc = await cookiesCol.findOne({
			cookie: sessionId.value,
		});

		if (!authDoc) {
			return [null, { code: 0, message: "Unauthorized" } as AnyError] as const;
		}

		const userCol = db.collection<UserData>("authentication");
		const userDoc = await userCol.findOne({ email: authDoc.email });

		if (!userDoc) {
			return [
				null,
				{ code: 1, message: "No doc in user col" } as AnyError,
			] as const;
		}

		return [userDoc, null] as const;
	} catch (e) {
		let message = "";
		if (typeof e === "string") {
			message = e;
		} else if (e instanceof Error) {
			message = e.message;
		}
		return [null, { code: 2, message: e } as AnyError] as const;
	}
}

function handleAuthError(
	err: AnyError,
	set: { status?: undefined | number | string },
) {
	switch (err.code) {
		case 0: {
			set.status = "Unauthorized";

			break;
		}
		// biome-ignore lint/suspicious/noFallthroughSwitchClause:
		case 2: {
			console.error(err.message);
		}
		case 1: {
			set.status = "Internal Server Error";

			break;
		}
		default: {
			console.warn(`Unknown AnyError code: ${err.code}. Error:`, err);
		}
	}
}

async function loadConfig() {
	let config = {
		port: 3005,
		mongourl: "mongodb://localhost:27017",
		datapath: `${import.meta.dir}/../../data`,
	};

	let envConfigPath = Bun.env.CONFIG_PATH;

	if (envConfigPath === undefined) {
		envConfigPath = `${import.meta.dir}/../../config/server.json`;
	}

	if (URL.canParse(envConfigPath)) {
		const resp = await fetch(envConfigPath);

		try {
			config = {
				...config,
				...(await resp.json()),
			};
		} catch (e) {
			console.error(`Couldn't parse response as json: ${e}`);
			console.log("Using default config");
		}

		return config;
	}

	try {
		config = {
			...config,
			...(await Bun.file(envConfigPath).json()),
		};
	} catch (e) {
		console.error(`Couldn't read config file: ${e}`);
		console.log("Using default config");
	}

	return config;
}

async function camUUIDtoUserId(uuid: string, mongo: MongoClient) {
	const db = mongo.db("setup3d");

	const users = db.collection<UserData>("authentication");

	const userDoc = await users.findOne({ cameras: uuid });

	if (userDoc) {
		return userDoc._id.toHexString();
	}

	return null;
}

const app = await main();

export type App = typeof app;
