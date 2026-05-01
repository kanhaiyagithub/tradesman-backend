const storageConfig = require('../../config/storage');
const localStorageProvider = require('./providers/localStorageProvider');

/**
 * Resolves the configured storage provider.
 *
 * Phase 1B keeps local storage as the active backend while giving the app a
 * stable interface that can later switch to S3 without controller rewrites.
 *
 * @returns {object} Active storage provider implementation.
 */
const getProvider = () => {
  switch (storageConfig.driver) {
    case 'local':
    default:
      return localStorageProvider;
  }
};

/**
 * Saves a single processed image file.
 *
 * @param {{ file: object, category: string }} params
 * @returns {Promise<string|null>} Normalized storage key.
 */
const saveSingleImage = async ({ file, category }) => {
  if (!file) {
    return null;
  }

  return getProvider().saveBuffer({ file, category });
};

/**
 * Saves multiple processed image files.
 *
 * @param {{ files: object[], category: string }} params
 * @returns {Promise<string[]>} Normalized storage keys.
 */
const saveMultipleImages = async ({ files = [], category }) => {
  const savedKeys = [];

  for (const file of files) {
    const savedKey = await saveSingleImage({ file, category });
    if (savedKey) {
      savedKeys.push(savedKey);
    }
  }

  return savedKeys;
};

/**
 * Deletes a stored object using the active provider.
 *
 * @param {string|null|undefined} storageKey - Stored key or legacy value.
 * @param {{ category?: string }} [options] - Category hint for legacy values.
 */
const deleteObject = async (storageKey, options = {}) => {
  await getProvider().deleteObject(storageKey, options);
};

/**
 * Deletes multiple stored objects using the active provider.
 *
 * @param {Array<string|null|undefined>} storageKeys - Stored keys or legacy values.
 * @param {{ category?: string }} [options] - Category hint for legacy values.
 */
const deleteObjects = async (storageKeys = [], options = {}) => {
  for (const storageKey of storageKeys) {
    await deleteObject(storageKey, options);
  }
};

/**
 * Converts a stored value into a public URL without exposing provider logic to
 * controllers.
 *
 * @param {string|null|undefined} storageKey - Stored key or legacy value.
 * @param {{ category?: string }} [options] - Category hint for legacy values.
 * @returns {string|null} Public URL.
 */
const toPublicUrl = (storageKey, options = {}) =>
  getProvider().getPublicUrl(storageKey, options);

/**
 * Converts a list of stored values into public URLs.
 *
 * @param {Array<string|null|undefined>} storageKeys - Stored keys or legacy values.
 * @param {{ category?: string }} [options] - Category hint for legacy values.
 * @returns {string[]} Public URLs.
 */
const toPublicUrls = (storageKeys = [], options = {}) =>
  (Array.isArray(storageKeys) ? storageKeys : [])
    .map((storageKey) => toPublicUrl(storageKey, options))
    .filter(Boolean);

module.exports = {
  saveSingleImage,
  saveMultipleImages,
  deleteObject,
  deleteObjects,
  toPublicUrl,
  toPublicUrls,
  normalizeStorageKey: (...args) => getProvider().normalizeStorageKey(...args),
};
