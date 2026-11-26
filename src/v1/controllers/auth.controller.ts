import type { Request, Response, NextFunction } from "express";
import { loginUserService, logoutUserService } from "../services/auth.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { LoginUserInput } from "../validators/auth.validator.js";

export const loginUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { user, token } = await loginUserService(req.validatedBody as LoginUserInput);
        return res.status(200).json({ success: true, message: "Logged in successfully", data: user, token });
    } catch (error) {
        next(error);
    }
};

export const logoutUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        await logoutUserService(requireUserId(req));
        return res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (error) {
        next(error);
    }
};
