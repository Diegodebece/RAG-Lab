import type { Request, Response, NextFunction } from "express";
import {
    createDocumentIndexService,
    deleteDocumentIndexService,
    getDocumentIndexByIdService
} from "../services/documentIndexes.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { CreateDocumentIndexInput } from "../validators/documentIndexes.validator.js";

// 202 when an index was queued (a new one, or a failed one queued again); 200 when the index was already there
export const createDocumentIndex = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const { index, created } = await createDocumentIndexService(requireUserId(req), req.params.id, req.validatedBody as CreateDocumentIndexInput);

        return created
            ? res.status(202).json({ success: true, message: "Index queued for building", data: index })
            : res.status(200).json({ success: true, message: "Index already exists", data: index });
    } catch (error) {
        next(error);
    }
};

export const getDocumentIndexById = async (req: Request<{ id: string; indexId: string }>, res: Response, next: NextFunction) => {
    try {
        const index = await getDocumentIndexByIdService(requireUserId(req), req.params.id, req.params.indexId);
        return res.status(200).json({ success: true, message: "Index retrieved successfully", data: index });
    } catch (error) {
        next(error);
    }
};

export const deleteDocumentIndex = async (req: Request<{ id: string; indexId: string }>, res: Response, next: NextFunction) => {
    try {
        await deleteDocumentIndexService(requireUserId(req), req.params.id, req.params.indexId);
        return res.status(200).json({ success: true, message: "Index deleted successfully" });
    } catch (error) {
        next(error);
    }
};
