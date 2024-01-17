import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import room from "../public/room.json";

const files = (await new Response(Bun.spawn(["ls", "./models"]).stdout).text())
	.trim()
	.split("\n")
	.map((x) => x.slice(0, x.length - 5));

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
	.onError((err) => {
		console.error(err);
	})
	.listen(3005);

export type App = typeof app;

console.log(`Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
