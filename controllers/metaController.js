const metaConversionService = require("../services/metaConversionService");

/**
 * Stores the authenticated user's device / attribution info for Meta tracking.
 * The body is untrusted: the service whitelists and sanitises every field.
 *
 * @route POST /api/meta/attribution
 * @access Private
 */
exports.saveAttribution = async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: "Request body must be a JSON object",
    });
  }

  const saved = await metaConversionService.trackAttributionOnly({
    userId: req.user.id,
    metaAttribution: body,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
  });

  return res.status(200).json({ success: true, data: { saved } });
};
