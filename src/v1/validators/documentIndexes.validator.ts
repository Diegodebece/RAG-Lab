import Joi from "joi";
import type { ConfigurationSettings } from "../types/configuration.type.js";
import { settingRuleFor } from "./configuration.validator.js";

// The two index-time settings, both optional: a missing one comes from the default profile. The route builds an index of a
// document that is already there, so no text, filename, question-time setting, owner or status is accepted.
export interface CreateDocumentIndexInput {
    chunkSize?: ConfigurationSettings["chunkSize"];
    embeddingModel?: ConfigurationSettings["embeddingModel"];
}

export const createDocumentIndexSchema = Joi.object<CreateDocumentIndexInput>({
    chunkSize: settingRuleFor("chunkSize"),
    embeddingModel: settingRuleFor("embeddingModel")
});
