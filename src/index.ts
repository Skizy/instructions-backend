import { readdir, exists } from "node:fs/promises";
import { Elysia, t } from "elysia";
import { Long, MongoClient, ObjectId } from "mongodb";
import { cors } from "@elysiajs/cors";
import room from "../public/room.json";
import { Dirent } from "fs";
import { $ } from "bun";

type Model = {
	name: string;
	manufacturer: string;
	date: number | Long;
	fileName: string;
	hidden?: boolean;
};

async function main() {
	const mongo = new MongoClient("mongodb://localhost:27017");

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
		.use(cors())
		.get("/", () => "Hello Elysia")
		.get("/room.json", () => room)
		.get("/modelList", async ({ set }) => {
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
					const file = Bun.file(`./assets/${id}/${doc.fileName}`);
					if (await file.exists()) {
						docs.push({
							id,
							name: doc.name,
							date: doc.date as number,
							manufacturer: doc.manufacturer,
						});
					} else {
						console.log(`${doc.name} at ${doc.fileName} does not exist`);
					}
				}

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

						if (
							!(await exists(`./assets/${model}`)) ||
							!(await exists(`./assets/${model}/${fileName}`))
						) {
							set.status = "Internal Server Error";
							return;
						}

						const assetsPath = `./assets/${model}/deps`;
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
						fd.append("file", Bun.file(`./assets/${model}/${fileName}`));
						fd.append("fileName", fileName);

						for (const file of files) {
							const name = file.name;
							fd.append(name, Bun.file(`${assetsPath}/${name}`));
						}

						return new Response(fd);
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
						await $`bash -c ${`mkdir -p ./assets/${id}/deps`}`;
						console.log("created a dir");

						await Bun.write(`./assets/${id}/${fileName}`, body.file);

						if (body.assets !== undefined && body.assets.type.length > 0) {
							$.cwd(`./assets/${id}/deps`);
							if (
								body.assets.type === "application/gzip" ||
								body.assets.type === "application/x-tar"
							) {
								const tmpFile = Bun.file(`./assets/${id}/.tmp.tar.gz`);
								await Bun.write(tmpFile, body.assets);
								await $`tar -xf ../.tmp.tar.gz`;
								await $`rm ../.tmp.tar.gz`;
							} else if (body.assets.type === "application/zip") {
								const tmpFile = Bun.file(`./assets/${id}/.tmp.zip`);
								await Bun.write(tmpFile, body.assets);
								await $`bsdtar -xf ../.tmp.zip`;
								await $`rm ../.tmp.zip`;
							}

							$.cwd("../..");
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
		.onError((err) => {
			console.error(err);
		})
		.listen(3005);

	console.log(
		`Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
	);

	return app;
}

const app = await main();

export type App = typeof app;
