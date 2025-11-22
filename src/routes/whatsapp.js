import { Router } from "express";
import Joi from "joi";
import {
  connectWhatsApp,
  getWhatsAppStatus,
  // New multi-number functions
  connectWhatsAppNumber,
  listWhatsAppNumbers,
  getWhatsAppNumberStatus,
  deleteWhatsAppNumber,
  setDefaultNumber,
  migrateToMultiNumber
} from "../controllers/whatsappController.js";

const router = Router();

const connectRequestSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  slug: Joi.string().trim().min(1).required(),
  telefono: Joi.string().trim().min(6).required(),
  webhookUrl: Joi.string().uri({ scheme: ["http", "https"] }).required()
});

router.post("/connect-whatsapp-colmado", async (req, res, next) => {
  try {
    const { error, value } = connectRequestSchema.validate(req.body, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await connectWhatsApp(value);
    const statusCode = result.created ? 201 : 200;
    return res.status(statusCode).json(result);
  } catch (err) {
    return next(err);
  }
});

const statusQuerySchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  includeQr: Joi.boolean()
    .truthy("true", "1", "yes")
    .falsy("false", "0", "no")
    .default(false)
});

router.get("/status", async (req, res, next) => {
  try {
    const { error, value } = statusQuerySchema.validate(req.query, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await getWhatsAppStatus({
      tiendaId: value.tiendaId,
      includeQr: value.includeQr
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

// ====================================
// NEW: Multi-Number WhatsApp Endpoints
// ====================================

// Validation Schemas for new endpoints

const connectNumberSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  slug: Joi.string().trim().min(1).required(),
  telefono: Joi.string().trim().min(6).required(),
  webhookUrl: Joi.string().uri({ scheme: ["http", "https"] }).required(),
  displayName: Joi.string().trim().min(1).max(50).optional()
});

const listNumbersSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required()
});

const numberStatusSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  numberId: Joi.string().trim().min(1).required(),
  includeQr: Joi.boolean()
    .truthy("true", "1", "yes")
    .falsy("false", "0", "no")
    .default(false)
});

const deleteNumberSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  numberId: Joi.string().trim().min(1).required()
});

const setDefaultSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  telefono: Joi.string().trim().min(6).required()
});

const migrateSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required()
});

// Routes

/**
 * POST /numbers/connect
 * Connect a new WhatsApp number to a store
 */
router.post("/numbers/connect", async (req, res, next) => {
  try {
    const { error, value } = connectNumberSchema.validate(req.body, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await connectWhatsAppNumber(value);
    const statusCode = result.created ? 201 : 200;
    return res.status(statusCode).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /numbers
 * List all WhatsApp numbers for a store
 */
router.get("/numbers", async (req, res, next) => {
  try {
    const { error, value } = listNumbersSchema.validate(req.query, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await listWhatsAppNumbers({
      tiendaId: value.tiendaId
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /numbers/:numberId/status
 * Get status of a specific WhatsApp number
 */
router.get("/numbers/:numberId/status", async (req, res, next) => {
  try {
    const { error, value } = numberStatusSchema.validate(
      {
        ...req.query,
        numberId: req.params.numberId
      },
      {
        abortEarly: false,
        allowUnknown: false
      }
    );

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await getWhatsAppNumberStatus({
      tiendaId: value.tiendaId,
      numberId: value.numberId,
      includeQr: value.includeQr
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /numbers/:numberId
 * Delete a WhatsApp number
 */
router.delete("/numbers/:numberId", async (req, res, next) => {
  try {
    const { error, value } = deleteNumberSchema.validate(
      {
        ...req.query,
        numberId: req.params.numberId
      },
      {
        abortEarly: false,
        allowUnknown: false
      }
    );

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await deleteWhatsAppNumber({
      tiendaId: value.tiendaId,
      numberId: value.numberId
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /numbers/default
 * Set a WhatsApp number as default
 */
router.put("/numbers/default", async (req, res, next) => {
  try {
    const { error, value } = setDefaultSchema.validate(req.body, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await setDefaultNumber({
      tiendaId: value.tiendaId,
      telefono: value.telefono
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /migrate
 * Migrate from legacy single-number to multi-number structure
 */
router.post("/migrate", async (req, res, next) => {
  try {
    const { error, value } = migrateSchema.validate(req.body, {
      abortEarly: false,
      allowUnknown: false
    });

    if (error) {
      return res.status(400).json({
        error: "validation_error",
        details: error.details.map((detail) => detail.message)
      });
    }

    const result = await migrateToMultiNumber({
      tiendaId: value.tiendaId
    });

    const statusCode = result.migrated ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
