import type { Request, Response, NextFunction } from "express";
import { changeUserPasswordService, createUserService, getCurrentUserService, updateUserService } from "../services/users.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { ChangePasswordInput, CreateUserInput, UpdateUserInput } from "../validators/users.validator.js";

export const getCurrentUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = await getCurrentUserService(requireUserId(req));
        return res.status(200).json({ success: true, message: "Current user retrieved successfully", data: user });
    } catch (error) {
        next(error);
    }
};

export const changeUserPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { user, token } = await changeUserPasswordService(requireUserId(req), req.validatedBody as ChangePasswordInput);
        return res.status(200).json({ success: true, message: "Password changed successfully", data: user, token });
    } catch (error) {
        next(error);
    }
};

export const createUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = await createUserService(req.validatedBody as CreateUserInput);
        return res.status(201).json({ success: true, message: "User created successfully", data: user });
    } catch (error) {
        next(error);
    }
};

export const updateUser = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const user = await updateUserService(requireUserId(req), id, req.validatedBody as UpdateUserInput);
        return res.status(200).json({ success: true, message: "User updated successfully", data: user });
    } catch (error) {
        next(error);
    }
};
