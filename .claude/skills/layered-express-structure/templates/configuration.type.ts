import type { SETTING_CAPS, SETTING_KEYS } from "../config/configuration.config.js";

export type SettingKey = (typeof SETTING_KEYS)[number];

// the type of one setting's value: one of the allowed values, or a number
type SettingValue<K extends SettingKey> = (typeof SETTING_CAPS)[K] extends { readonly allowed: readonly (infer V)[] } ? V : number;

// the eleven settings, all of them: what a question runs with
export type ConfigurationSettings = { [K in SettingKey]: SettingValue<K> };

// what the API tells a client about one setting, from its cap
export interface SettingDefinition {
    key: SettingKey;
    label: string;
    kind: "index" | "question";
    type: "integer" | "number" | "string";
    allowed?: readonly (string | number)[];
    min?: number;
    max?: number;
    decimals?: number;
}

// what GET /v1/configuration returns
export interface ConfigurationView {
    version: number;
    defaults: Record<string, unknown>;
    settings: SettingDefinition[];
    profiles: { maxPerUser: number; maxNameLength: number };
}

// the configuration a question runs with, stored next to its metrics
export interface ConfigurationSnapshot {
    version: number;
    settings: Readonly<ConfigurationSettings>;
}

// the answer of the resolver: which profile was asked for (null for none), what was resolved, its canonical text and
// the SHA-256 of that text
export interface ResolvedConfiguration {
    profileId: string | null;
    snapshot: Readonly<ConfigurationSnapshot>;
    snapshotText: string;
    hash: string;
}
