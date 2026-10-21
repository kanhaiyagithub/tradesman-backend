/**
 * Reading the licence fields a person typed or an app sent.
 *
 * Old app versions always send the licence fields, as empty strings when the person left them blank (and
 * "null"/"undefined" when a value was missing on their side), so all of those mean "not provided".
 */

/** Empty, whitespace-only, "null" and "undefined" all mean "nothing was given". */
const normalizeOptionalText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || ["null", "undefined"].includes(text.toLowerCase())) return null;
  return text;
};

const isValidDate = (text) => !Number.isNaN(new Date(text).getTime());

/**
 * @param {{ number: *, expiry: *, hasDocument: boolean }} input  hasDocument: a licence document file came with the request
 * @returns {{ number: string|null, expiry: string|null, hasDocument: boolean, expiryInvalid: boolean,
 *             missing: string[], complete: boolean }}
 *   missing: which of licenseNumber / licenseExpiry / licenseDocument were not given; complete: all three given and valid.
 */
const parseLicenceInput = ({ number, expiry, hasDocument }) => {
  const parsedNumber = normalizeOptionalText(number);
  const parsedExpiry = normalizeOptionalText(expiry);

  const missing = [];
  if (!parsedNumber) missing.push("licenseNumber");
  if (!parsedExpiry) missing.push("licenseExpiry");
  if (!hasDocument) missing.push("licenseDocument");

  const expiryInvalid = Boolean(parsedExpiry) && !isValidDate(parsedExpiry);
  return {
    number: parsedNumber,
    expiry: parsedExpiry,
    hasDocument: Boolean(hasDocument),
    expiryInvalid,
    missing,
    complete: missing.length === 0 && !expiryInvalid,
  };
};

module.exports = { normalizeOptionalText, parseLicenceInput };
