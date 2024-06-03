import { readdir, access } from "node:fs/promises";
import { Elysia, t } from "elysia";
import { Long, MongoClient, ObjectId } from "mongodb";
import type { Dirent } from "node:fs";
import { $ } from "bun";

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
};

type CookieDoc = {
	email: string;
	cookie: string;
};

async function main() {
	const config = await loadConfig();

	const mongo = new MongoClient(config.mongourl);

	const date = new Long(BigInt(Date.now()));

	console.debug(date);

	const db = mongo.db("setup3d");
	const col = db.collection<Model>("devcollection");

	for await (const doc of col.find()) {
		console.dir(doc);
	}

	const app = new Elysia()
		// .use(cors())
		.get("/ping", () => "pong")
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
		.get("/modelList", async ({ set, headers }) => {
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
						access(`${config.datapath}/${id}/${doc.fileName}`);
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
		.get(
			"/models/:model",
			async ({ params: { model }, set }) => {
				const id = new ObjectId(model);

				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("devcollection");

					const doc = await col.findOne({ _id: id });
					if (doc !== null) {
						const fileName = doc.fileName;

						const assetsPath = `${config.datapath}/${model}/deps`;
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
							Bun.file(`${config.datapath}/${model}/${fileName}`),
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
		.post(
			"/models",
			async ({ body, cookie, set }) => {
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
						await $`mkdir -p ${config.datapath}/${id}/deps`;
						console.log("created a dir");

						await Bun.write(`${config.datapath}/${id}/${fileName}`, body.file);

						console.debug(body.assets);

						if (body.assets !== undefined && body.assets.type.length > 0) {
							const workingDirectory = await $`pwd`.text();
							$.cwd(`${config.datapath}/${id}/deps`);
							if (
								body.assets.type === "application/gzip" ||
								body.assets.type === "application/x-tar"
							) {
								const tmpFile = Bun.file(
									`${config.datapath}/${id}/.tmp.tar.gz`,
								);
								await Bun.write(tmpFile, body.assets);
								await $`tar -xf ../.tmp.tar.gz`;
								await $`rm ../.tmp.tar.gz`;
							} else if (body.assets.type === "application/zip") {
								const tmpFile = Bun.file(`${config.datapath}/${id}/.tmp.zip`);
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
		.delete(
			"/models/:id",
			async ({ params: { id }, set, body }) => {
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
						await $`mv ${config.datapath}/${id} ${config.datapath}/trash`.quiet();
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
		.get("/:asset", async ({ params: { asset }, set }) => {
			const file = Bun.file(`./frontend/${asset}`);
			if (await file.exists()) {
				return file;
			}

			set.status = "Not Found";
			return "Not found";
		})
		.post(
			"/login",
			async ({ body, set }) => {
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

						set.headers["Set-Cookie"] = `session-id=${uuid}`;

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
			async ({ body, set }) => {
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
		.post(
			"/auth",
			async ({ body, set }) => {
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
		.delete(
			"/logout",
			async ({ body, set }) => {
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
		.post(
			"/userData",
			async ({ body, set }) => {
				try {
					const db = mongo.db("setup3d");
					const cookiesCol = db.collection<CookieDoc>("cookies");
					const doc = await cookiesCol.findOne({ cookie: body.sessionId });

					if (doc) {
						const userCol = db.collection<UserData>("authentication");
						const user = await userCol.findOne({ email: doc.email });

						if (user) {
							return {
								name: user.name,
								email: user.email,
								avatarLink: user.avatarLink,
								uploadedModels: user.uploadedModels,
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
			},
			{
				body: t.Object({ sessionId: t.String() }),
			},
		)
		.post(
			"/modelData",
			async ({ set, body }) => {
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
		.post(
			"/search",
			async ({ body, set }) => {
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
		.post(
			"/uploadRigData",
			async ({ body, set, cookie }) => {
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
		.get("/rigData", async ({ set, cookie }) => {
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
		.get("/rigData/:id", async ({ params: { id }, set }) => {
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

const app = await main();

export type App = typeof app;
