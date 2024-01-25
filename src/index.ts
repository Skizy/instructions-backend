import { Elysia, t } from "elysia";
import { Long, MongoClient } from "mongodb";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import room from "../public/room.json";

type Model = {
	// id: number;
	name: string;
	manufacturer: string;
	date: number | Long;
	fileName: string;
};

async function main() {
	const files = (
		await new Response(Bun.spawn(["ls", "./models"]).stdout).text()
	)
		.trim()
		.split("\n")
		.map((x) => x.slice(0, x.length - 5));

	const mongo = new MongoClient("mongodb://localhost:27017");

	const date = new Long(BigInt(Date.now()));

	console.debug(date);

	try {
		const db = mongo.db("setup3d");
		const col = db.collection<Model>("models");

		for await (const doc of col.find()) {
			console.dir(doc);
		}
	} finally {
		mongo.close();
	}

	const app = new Elysia()
		.use(cors())
		.use(staticPlugin())
		.get("/", () => "Hello Elysia")
		.head("/public", () => undefined)
		.get("/room.json", () => room)
		.get("/modelList", () => files)
		.get("/models/:model", async ({ params: { model }, set }) => {
			const modelFile = Bun.file(`./models/${model}.gltf`);

			if (await modelFile.exists()) {
				return modelFile.text();
			}

			set.status = "Not Found";
			return;
		})
		.post(
			"/models",

			async ({ body, set }) => {
				const formData = body;
				console.dir(formData);

				const fileName = body.file.name;
				await Bun.write(`./uploaded_stuff/${fileName}`, body.file);
				const date = new Long(BigInt(Date.now()));

				// TODO: Do this asynchronously
				try {
					mongo.connect();
					const db = mongo.db("setup3d");
					const col = db.collection<Model>("models");

					await col.insertOne({
						fileName,
						name: body.modelName,
						manufacturer: body.manufacturer,
						date,
					});
				} finally {
					mongo.close();
				}

				set.status = "Created";
				return;
			},
			{
				body: t.Object({
					file: t.File(),
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
