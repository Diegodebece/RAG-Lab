import type { Request, Response, NextFunction } from "express";
import { getConfigurationService, resolveConfigurationService } from "../services/configuration.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { ResolveConfigurationInput } from "../validators/configuration.validator.js";

export const getConfiguration = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const configuration = await getConfigurationService();
        return res.status(200).json({ success: true, message: "Configuration retrieved successfully", data: configuration });
    } catch (error) {
        next(error);
    }
};

// the answer leaves out the canonical text: the snapshot and its hash are what a client needs
export const resolveConfiguration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { profileId, snapshot, hash } = await resolveConfigurationService(requireUserId(req), req.validatedBody as ResolveConfigurationInput);
        return res.status(200).json({ success: true, message: "Configuration resolved successfully", data: { profileId, snapshot, hash } });
    } catch (error) {
        next(error);
    }
};
