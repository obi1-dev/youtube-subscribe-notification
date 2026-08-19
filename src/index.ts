import { Hono } from "hono";

type Bindings = {
	YT_SUBS: KVNamespace;
	DISCORD_WEBHOOK_URL: string;
	CALLBACK_BASE_URL: string;
	HUB_SECRET: string;
};

const HUB_URL = "";

const app = new Hono();

app.get("/", (c) => {
	return c.text("Hello Hono!");
});

export default app;
