import type { ConfigurationPreview } from "../types/configuration.type.js";
import type { ResolveConfigurationInput } from "../validators/configuration.validator.js";
import { resolveConfigurationService } from "./configuration.service.js";
import { findIndexStateService } from "./documentIndexes.service.js";

// The dry run of a configuration (POST /v1/configuration/resolve): what the body resolves to and, when it names a document, which
// index of that document it would use. It builds nothing and counts nothing: no index, chunk, usage or run is written, and the
// model server is not asked. The configuration is resolved first, so its problems (a profile not found, a value outside its caps)
// are answered before the document is looked at. A document that is not the caller's is the usual 404, an admin's request included.
// It is a service of its own because documentIndexes.service.ts already imports configuration.service.ts, and the other direction
// would be an import cycle.
export const previewConfigurationService = async (userId: string, input: ResolveConfigurationInput): Promise<ConfigurationPreview> => {
    const { profileId, snapshot, hash } = await resolveConfigurationService(userId, input);
    const preview: ConfigurationPreview = { profileId, snapshot, hash };

    if (input.documentId !== undefined) {
        preview.index = await findIndexStateService(userId, input.documentId, snapshot.settings);
    }

    return preview;
};
