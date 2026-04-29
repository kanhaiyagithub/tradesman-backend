/**
 * Converts a direct-message user pair into a stable conversation key.
 *
 * The smaller numeric user id is always placed first so both directions
 * of the same chat resolve to a single shared key.
 *
 * @param {number|string} userAId - First user id.
 * @param {number|string} userBId - Second user id.
 * @returns {string} Stable key in the format "smallerId_biggerId".
 */
const buildConversationKey = (userAId, userBId) => {
  const normalizedUserAId = Number(userAId);
  const normalizedUserBId = Number(userBId);

  return normalizedUserAId < normalizedUserBId
    ? `${normalizedUserAId}_${normalizedUserBId}`
    : `${normalizedUserBId}_${normalizedUserAId}`;
};

/**
 * Parses a direct-message conversation key back into the participating user ids.
 *
 * @param {string} conversationKey - Stored direct chat key.
 * @returns {{ userOneId: number, userTwoId: number }} Parsed user ids.
 * @throws {Error} When the key is missing or does not contain two numeric ids.
 */
const parseConversationKey = (conversationKey) => {
  const [userOnePart, userTwoPart] = String(conversationKey || '').split('_');
  const userOneId = Number(userOnePart);
  const userTwoId = Number(userTwoPart);

  if (!userOneId || !userTwoId) {
    throw new Error(`Invalid conversationKey: ${conversationKey}`);
  }

  return {
    userOneId,
    userTwoId,
  };
};

/**
 * Builds a compact preview string for inbox rendering.
 *
 * @param {string} message - Full message body.
 * @param {number} [maxLength=500] - Maximum preview length.
 * @returns {string|null} Trimmed preview or null for empty input.
 */
const buildMessagePreview = (message, maxLength = 500) => {
  if (!message) {
    return null;
  }

  const normalizedMessage = String(message).trim().replace(/\s+/g, ' ');

  if (!normalizedMessage) {
    return null;
  }

  return normalizedMessage.length > maxLength
    ? `${normalizedMessage.slice(0, Math.max(maxLength - 3, 1))}...`
    : normalizedMessage;
};

module.exports = {
  buildConversationKey,
  parseConversationKey,
  buildMessagePreview,
};
