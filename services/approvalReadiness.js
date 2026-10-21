/**
 * What a tradesperson's profile must contain before it can be approved (by an admin, or automatically).
 *
 *  - always: trade, business name, short bio and a profile photo
 *  - licence number, expiry and document: ONLY for licence-required trades
 *  - portfolio photos: never required (optional, the app just encourages them)
 *
 * `profileImage` is checked only when passed (callers that have the user row pass it); `licenceRequired`
 * defaults to true so a caller that forgets it errs on the strict side.
 */

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

/** Returns the names of the missing fields (empty when the profile is ready). */
const validateApprovalReadiness = (details, { licenceRequired = true, profileImage } = {}) => {
  const missing = [];

  if (!details.tradeTypeId) missing.push("tradeTypeId");
  if (!normalizeOptionalString(details.tradeType)) missing.push("tradeType");
  if (!normalizeOptionalString(details.businessName)) missing.push("businessName");
  if (!normalizeOptionalString(details.shortBio)) missing.push("shortBio");

  if (profileImage !== undefined && !normalizeOptionalString(profileImage)) missing.push("profileImage");

  if (licenceRequired) {
    if (!normalizeOptionalString(details.licenseNumber)) missing.push("licenseNumber");
    if (!details.licenseExpiry) missing.push("licenseExpiry");
    if (!normalizeOptionalString(details.licenseDocument)) missing.push("licenseDocument");
  }

  return missing;
};

module.exports = { normalizeOptionalString, validateApprovalReadiness };
