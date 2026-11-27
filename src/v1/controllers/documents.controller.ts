import type { Request, Response, NextFunction } from "express";
import {
    createDocumentService,
    deleteDocumentService,
    getDocumentByIdService,
    getDocumentsService
} from "../services/documents.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { CreateDocumentInput } from "../validators/documents.validator.js";

export const getDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const documents = await getDocumentsService(requireUserId(req));
        return res.status(200).json({ success: true, message: "Documents retrieved successfully", data: documents });
    } catch (error) {
        next(error);
    }
};

export const getDocumentById = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const document = await getDocumentByIdService(requireUserId(req), req.params.id);
        return res.status(200).json({ success: true, message: "Document retrieved successfully", data: document });
    } catch (error) {
        next(error);
    }
};

// 202: the document is stored and its index is queued; the index is built later, and its status says how far it is
export const createDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const document = await createDocumentService(requireUserId(req), req.validatedBody as CreateDocumentInput);
        return res.status(202).json({ success: true, message: "Document accepted for indexing", data: document });
    } catch (error) {
        next(error);
    }
};

export const deleteDocument = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        await deleteDocumentService(requireUserId(req), req.params.id);
        return res.status(200).json({ success: true, message: "Document deleted successfully" });
    } catch (error) {
        next(error);
    }
};
