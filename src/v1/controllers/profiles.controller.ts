import type { Request, Response, NextFunction } from "express";
import {
    createProfileService,
    deleteProfileService,
    getProfileByIdService,
    getProfilesService,
    updateProfileService
} from "../services/profiles.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { CreateProfileInput, UpdateProfileInput } from "../validators/profiles.validator.js";

export const getProfiles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const profiles = await getProfilesService(requireUserId(req));
        return res.status(200).json({ success: true, message: "Profiles retrieved successfully", data: profiles });
    } catch (error) {
        next(error);
    }
};

export const getProfileById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const profile = await getProfileByIdService(requireUserId(req), req.params.id);
        return res.status(200).json({ success: true, message: "Profile retrieved successfully", data: profile });
    } catch (error) {
        next(error);
    }
};

export const createProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const profile = await createProfileService(requireUserId(req), req.validatedBody as CreateProfileInput);
        return res.status(201).json({ success: true, message: "Profile created successfully", data: profile });
    } catch (error) {
        next(error);
    }
};

export const updateProfile = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const profile = await updateProfileService(requireUserId(req), req.params.id, req.validatedBody as UpdateProfileInput);
        return res.status(200).json({ success: true, message: "Profile updated successfully", data: profile });
    } catch (error) {
        next(error);
    }
};

export const deleteProfile = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        await deleteProfileService(requireUserId(req), req.params.id);
        return res.status(200).json({ success: true, message: "Profile deleted successfully" });
    } catch (error) {
        next(error);
    }
};
