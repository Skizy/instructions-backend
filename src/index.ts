import { readdir, access } from "node:fs/promises";
import { Elysia, t } from "elysia";
import { Long, MongoClient, ObjectId } from "mongodb";
import { cors } from "@elysiajs/cors";
import { Dirent } from "fs";
import { $ } from "bun";

type Model = {
	name: string;
	manufacturer: string;
	date: number | Long;
	fileName: string;
	hidden?: boolean;
};

type UserData = {
	email: string;
	name: string;
	avatarLink: string;
	passwordHash: string;
};

type CookieDoc = {
	email: string;
	cookie: string;
};

async function main() {
	let config = {
		port: 3005,
		mongourl: "mongodb://localhost:27017",
		datapath: `${import.meta.dir}/../../data`,
	};

	let envConfigPath = Bun.env.CONFIG_PATH;

	if (envConfigPath === undefined) {
		envConfigPath = `${import.meta.dir}/../../config/server.json`;
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

	const mongo = new MongoClient(config.mongourl);

	const date = new Long(BigInt(Date.now()));

	console.debug(date);

	try {
		const db = mongo.db("setup3d");
		const col = db.collection<Model>("devcollection");

		for await (const doc of col.find()) {
			console.dir(doc);
		}
	} finally {
		await mongo.close();
	}

	const app = new Elysia()
		// .use(cors())
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
				await mongo.connect();
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
			} finally {
				await mongo.close();
			}
		})
		.get(
			"/models/:model",
			async ({ params: { model }, set }) => {
				const id = new ObjectId(model);

				try {
					await mongo.connect();
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
				} finally {
					await mongo.close();
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
			async ({ body, set }) => {
				console.dir(body);

				try {
					await mongo.connect();
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("devcollection");

					const fileName = body.file.name;
					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						fileName,
						name: body.modelName,
						manufacturer: body.manufacturer,
						date,
					});

					if (result.insertedId !== null) {
						console.log(
							"Writing the file and extracting files from the archive",
						);
						const id = result.insertedId.toHexString();

						console.log("creating a dir");
						// await $`bash -c ${`mkdir -p ./assets/${id}/deps`}`;
						await $`mkdir -p ${config.datapath}/${id}/deps`;
						console.log("created a dir");

						await Bun.write(`${config.datapath}/${id}/${fileName}`, body.file);

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
							}

							$.cwd(workingDirectory);
						}
					} else {
						throw new Error("Didn't get the id of the inserted document");
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";
					return;
				} finally {
					await mongo.close();
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
					const connect = await mongo.connect();
					const db = connect.db("setup3d");
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
				} finally {
					mongo.close();
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
					const connect = await mongo.connect();
					const db = connect.db("setup3d");
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
					});
					const uuid = crypto.randomUUID();

					const col2 = db.collection("cookies");
					await col2.insertOne({ email: body.email, cookie: uuid });

					set.headers["Set-Cookie"] = `session-id=${uuid}`;

					set.status = "Created";
				} catch (err) {
					console.error("Error: ", err);

					set.status = "Internal Server Error";
				} finally {
					mongo.close();
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
					const connect = await mongo.connect();
					const db = connect.db("setup3d");
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
				} finally {
					mongo.close();
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
					const connect = await mongo.connect();
					const db = connect.db("setup3d");
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
				} finally {
					mongo.close();
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
					const connect = await mongo.connect();
					const db = connect.db("setup3d");
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
				} finally {
					mongo.close();
				}
			},
			{
				body: t.Object({ sessionId: t.String() }),
			},
		)
		.onError((err) => {
			console.error(err);
		})
		.listen(config.port);

	console.log(
		`Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
	);

	return app;
}

const app = await main();

export type App = typeof app;
