import { pool } from "../config/db.config.js";
import { HEALTH_CACHE_SECONDS } from "../config/limits.config.js";
import { REQUIRED_MODELS } from "../config/ollama.config.js";
import type { HealthReport, ServiceState } from "../types/health.type.js";
import { listInstalledModelsService } from "./ollama.service.js";

const OLLAMA_TIMEOUT_MS = 2000;

// Errors are caught on purpose in this file: a failing dependency is reported as "down", not thrown.
const checkDatabase = async (): Promise<ServiceState> => {
    try {
        await pool.query("SELECT 1");
        return "up";
    } catch {
        return "down";
    }
};

// Ollama counts as up only if it answers in time and every required model is installed (names matched exactly).
const checkOllama = async (): Promise<ServiceState> => {
    try {
        const installed = await listInstalledModelsService({ timeoutMs: OLLAMA_TIMEOUT_MS });

        return REQUIRED_MODELS.every((model) => installed.includes(model)) ? "up" : "down";
    } catch {
        return "down";
    }
};

const checkHealth = async (): Promise<HealthReport> => {
    const [database, ollama] = await Promise.all([checkDatabase(), checkOllama()]);

    let status: HealthReport["status"] = "ok";

    if (database === "down") {
        status = "down";
    } else if (ollama === "down") {
        status = "degraded";
    }

    return { status, database, ollama };
};

// the report being reused, or being checked right now
let cache: { report: Promise<HealthReport>; expiresAt: number } | null = null;

// Anyone can call the health check, and each check queries the database and Ollama, so a report is reused for
// HEALTH_CACHE_SECONDS: a flood of requests becomes one check every few seconds. Requests that arrive while a
// check runs wait for that same check. The checks never throw, so a cached report is always a valid one.
export const getHealthService = async (): Promise<HealthReport> => {
    if (!cache || cache.expiresAt <= Date.now()) {
        cache = { report: checkHealth(), expiresAt: Date.now() + HEALTH_CACHE_SECONDS * 1000 };
    }

    return cache.report;
};
