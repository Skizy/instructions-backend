import { $ } from "bun";

import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";

import { Elysia, t } from "elysia";
import { Long, ObjectId } from "mongodb";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import {
	type CookieDoc,
	type Instruction,
	type UserData,
	authenticate,
	handleAuthError,
} from "../utils";

export const instructionsHandlers = (config: AppConfig) =>
	new Elysia({
		name: "instructionsHandlers",
	})
		.use(setup(config.mongourl))
		.get("/instructionsList", async ({ set, headers, cookie, mongo }) => {
			const [doc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);

				return;
			}

			try {
				const db = mongo.db("setup3d");
				const col = db.collection<Instruction>("devcollection");
				const cur = col.find({
					hidden: { $not: { $eq: true } },
					_id: {
						$in: doc.uploadedInstructions.map((x) => new ObjectId(x)),
					},
				});
				const docs: {
					id: string;
					name: string;
					date: number;
					manufacturer: string;
				}[] = [];
				for await (const doc of cur) {
					const id = doc._id.toHexString();

					try {
						await access(
							`${config.datapath}/instructions/${id}/${doc.fileName}`,
						);
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

				console.debug("Returning instruction list to request with headers:");
				console.debug(headers);

				return docs;
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		.get(
			"/instructions/:id",
			async ({ params: { id }, set, mongo }) => {
				const oid = new ObjectId(id);

				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Instruction>("devcollection");

					const doc = await col.findOne({ _id: oid });
					if (doc !== null) {
						const fileName = doc.fileName;

						const assetsPath = `${config.datapath}/instructions/${id}/deps`;
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
								"Directory with assets for this instruction doesn't exist:",
								e,
							);
							files = [];
						}

						const fd = new FormData();
						fd.append(
							"file",
							Bun.file(`${config.datapath}/instructions/${id}/${fileName}`),
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
				type: "multipart/form-data",
			},
		)
		.post(
			"/instructions",
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

					const col = db.collection<Instruction>("devcollection");

					const fileName = body.file.name;
					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						fileName,
						name: body.name,
						manufacturer: body.manufacturer,
						date,
						uploader: userDoc._id.toHexString(),
					});

					if (result.insertedId !== null) {
						console.log(
							"Writing the file and extracting files from the archive",
						);
						const id = result.insertedId.toHexString();

						console.log("creating a dir");
						await $`mkdir -p ${config.datapath}/instructions/${id}/deps`;
						console.log("created a dir");

						await Bun.write(
							`${config.datapath}/instructions/${id}/${fileName}`,
							body.file,
						);

						console.debug(body.assets);

						if (body.assets !== undefined && body.assets.type.length > 0) {
							const workingDirectory = await $`pwd`.text();
							$.cwd(`${config.datapath}/instructions/${id}/deps`);
							if (
								body.assets.type === "application/gzip" ||
								body.assets.type === "application/x-tar"
							) {
								const tmpFile = Bun.file(
									`${config.datapath}/instructions/${id}/.tmp.tar.gz`,
								);
								await Bun.write(tmpFile, body.assets);
								await $`tar -xf ../.tmp.tar.gz`;
								await $`rm ../.tmp.tar.gz`;
							} else if (body.assets.type === "application/zip") {
								const tmpFile = Bun.file(
									`${config.datapath}/instructions/${id}/.tmp.zip`,
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
							{ $addToSet: { uploadedInstructions: id } },
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
					name: t.String(),
				}),
			},
		)
		.delete(
			"/instructions/:id",
			async ({ params: { id }, set, cookie, mongo }) => {
				const sessionId = cookie["session-id"];
				if (!sessionId.value) {
					set.status = "Unauthorized";
					return;
				}

				try {
					const db = mongo.db("setup3d");
					const cookiesCol = db.collection<CookieDoc>("cookies");
					const doc = await cookiesCol.findOne({ cookie: sessionId.value });

					if (!doc) {
						set.status = "Unauthorized";
						return;
					}

					const userCol = db.collection<UserData>("authentication");
					const user = await userCol.findOne({ email: doc.email });

					if (!user || !user.uploadedInstructions.includes(id)) {
						set.status = "Unauthorized";
						return;
					}

					const instructionsCol = db.collection<Instruction>("devcollection");

					const { exitCode, stderr } =
						await $`mv ${config.datapath}/instructions/${id} ${config.datapath}/trash`.quiet();
					if (exitCode !== 0) {
						throw new Error(
							`Process exited with code ${exitCode}. stderr: ${String.fromCharCode(
								...stderr,
							)}`,
						);
					}

					const result = await instructionsCol.deleteOne({
						_id: ObjectId.createFromHexString(id),
					});
					if (result.deletedCount !== 1) {
						throw "Failed to delete the instruction document from the database";
					}

					const result2 = await userCol.updateOne(
						{ _id: user._id },
						{ $pull: { uploadedInstructions: id } },
					);
					if (result2.modifiedCount !== 1) {
						throw "Failed to remove the instruction id from the user's document";
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";

					return;
				}
			},
		)
		.post(
			"/search",
			async ({ body, set, mongo }) => {
				const q = body.query;

				try {
					const db = mongo.db("setup3d");
					const col = db.collection<Instruction>("devcollection");
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
		);
