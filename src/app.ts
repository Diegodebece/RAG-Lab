import "dotenv/config";
import express from "express";
import cors from "cors";
import { ADDRESS_REQUEST_WINDOW_MS, REQUESTS_PER_ADDRESS_PER_MINUTE } from "./v1/config/limits.config.js";
import { CORS_ORIGINS, TRUSTED_PROXIES } from "./v1/config/server.config.js";
import { v1Router } from "./v1/v1.routes.js";
import { rateLimitMiddleware } from "./v1/middlewares/rateLimit.middleware.js";
import { securityHeadersMiddleware } from "./v1/middlewares/securityHeaders.middleware.js";
import { notFoundMiddleware } from "./v1/middlewares/notFound.middleware.js";
import { errorMiddleware } from "./v1/middlewares/error.middleware.js";

export const app = express();

// do not advertise the framework in every response
app.disable("x-powered-by");

// req.ip is the real client address only for requests that come through a trusted proxy (see server.config.ts)
app.set("trust proxy", TRUSTED_PROXIES);

app.use(securityHeadersMiddleware);
app.use(cors(CORS_ORIGINS.length > 0 ? { origin: CORS_ORIGINS } : undefined));

// A limit per client address in front of everything, so an address that floods the API (forged tokens, unknown paths,
// login attempts) is answered with a 429 before its token is checked or the database is asked. After cors, whose
// preflight answers (OPTIONS) end here without being counted: they carry no credentials and do nothing.
app.use(rateLimitMiddleware({ limit: REQUESTS_PER_ADDRESS_PER_MINUTE, windowMs: ADDRESS_REQUEST_WINDOW_MS, keyBy: "ip" }));

// No global body parser: each route that takes a body parses it with express.json(), after authentication
// and the rate limits, so rejected requests never get their body read.

app.use("/v1", v1Router);

app.use(notFoundMiddleware);
app.use(errorMiddleware);
