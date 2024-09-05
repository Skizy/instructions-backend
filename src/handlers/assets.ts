import { Elysia } from "elysia";

import type { AppConfig } from "../config";

export const assetsHandlers = (config: AppConfig) =>
	new Elysia({
		name: "assetsHandlers",
	})
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
		.get("/assets/:asset", async ({ params: { asset }, set }) => {
			const file = Bun.file(`./public/${asset}`);
			if (await file.exists()) {
				return file;
			}

			set.status = "Not Found";
			return "Not found";
		});
