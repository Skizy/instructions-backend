import { Elysia } from "elysia";

import { loadConfig } from "./config";
import { setup } from "./setup";

import { assetsHandlers } from "./handlers/assets";
import { authenticationHandlers } from "./handlers/authentication";
import { cameraHandlers } from "./handlers/cameras";
import { characterModelHandlers } from "./handlers/character_models";
import { instructionsHandlers } from "./handlers/instructions";
import { modelsHandlers } from "./handlers/models";
import { timesyncHandlers } from "./handlers/timesync";

async function main() {
	const config = await loadConfig();

	const app = new Elysia()
		.use(setup(config.mongourl))
		.onBeforeHandle((context) => {
			console.log(`Responding to ${context.path}`);
		})
		.onError(({ code, error, set }) => {
			console.error(error);

			if (code === "VALIDATION") {
				set.status = "Bad Request";

				return error.toString();
			}

			return "";
		})
		.use(assetsHandlers(config))
		.use(instructionsHandlers(config))
		.use(authenticationHandlers(config))
		.use(modelsHandlers(config))
		.use(timesyncHandlers(config))
		.use(cameraHandlers(config))
		.use(characterModelHandlers(config))
		.listen(config.port);

	console.log(
		`Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
	);

	return app;
}

const app = await main();

export type App = typeof app;
