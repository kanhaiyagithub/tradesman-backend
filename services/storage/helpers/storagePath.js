/**
 * Maps logical storage categories and incoming multer field names to the
 * normalized storage category used by the provider.
 */
const FIELD_TO_CATEGORY = {
  profileImage: 'profile',
  portfolioPhotos: 'portfolio',
  photos: 'portfolio',
  licenseDocument: 'license',
};

/**
 * Resolves a logical storage category.
 *
 * @param {string} input - Category or incoming field name.
 * @returns {'profile'|'portfolio'|'license'} Normalized category.
 */
const resolveStorageCategory = (input) => {
  const normalizedInput = String(input || '').trim();

  if (FIELD_TO_CATEGORY[normalizedInput]) {
    return FIELD_TO_CATEGORY[normalizedInput];
  }

  if (['profile', 'portfolio', 'license'].includes(normalizedInput)) {
    return normalizedInput;
  }

  throw new Error(`Unsupported storage category: ${normalizedInput || 'unknown'}`);
};

/**
 * Returns the storage folder name for a normalized category.
 *
 * @param {'profile'|'portfolio'|'license'} category - Normalized category.
 * @returns {string} Relative folder inside the storage root.
 */
const getCategoryFolder = (category) => resolveStorageCategory(category);

module.exports = {
  resolveStorageCategory,
  getCategoryFolder,
};
