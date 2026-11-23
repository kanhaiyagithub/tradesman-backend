const multer = require('multer');
const sharp = require('sharp');
const { resolveStorageCategory } = require('../services/storage/helpers/storagePath');

const MAX_INPUT_PIXELS = 40 * 1000 * 1000;

/**
 * Shared in-memory upload middleware.
 *
 * Why memory storage:
 * - validation happens before persistence
 * - image transformation happens in memory
 * - the storage provider decides the final backend (local now, S3 later)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 12,
    fields: 40,
    parts: 60,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(null, false);
    req.fileValidationError =
      'Invalid image format. Allowed formats: JPG, JPEG, PNG.';
  },
});

/**
 * Converts uploaded images to JPEG in memory and annotates files with the
 * metadata required by the storage service.
 *
 * Controllers stay storage-agnostic by consuming:
 * - `file.processedBuffer`
 * - `file.processedMimeType`
 * - `file.processedExtension`
 * - `file.storageCategory`
 */
const convertToJpg = async (req, res, next) => {
  if (req.fileValidationError) {
    return res.status(400).json({
      success: false,
      message: req.fileValidationError,
    });
  }

  try {
    if (!req.files && !req.file) {
      return next();
    }

    const files = [];

    if (req.file) {
      files.push(req.file);
    }

    if (req.files) {
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else {
        Object.values(req.files).forEach((value) => {
          if (Array.isArray(value)) {
            files.push(...value);
          }
        });
      }
    }

    for (const file of files) {
      // rotate() applies the phone's EXIF orientation, flatten() puts transparent PNGs on white
      // (instead of black), limitInputPixels rejects decompression bombs.
      file.processedBuffer = await sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer();
      file.processedMimeType = 'image/jpeg';
      file.processedExtension = 'jpg';
      file.storageCategory = resolveStorageCategory(file.fieldname);
    }

    return next();
  } catch (error) {
    console.error('Image processing error:', error);
    return res.status(400).json({
      success: false,
      message: 'Invalid image file',
    });
  }
};

/**
 * Error middleware for upload routes: multer limit errors (file too large, too many
 * files/fields) are client mistakes, so they answer 400/413 instead of a generic 500.
 */
const handleUploadErrors = (error, req, res, next) => {
  if (!(error instanceof multer.MulterError)) return next(error);

  const tooLarge = error.code === 'LIMIT_FILE_SIZE';
  return res.status(tooLarge ? 413 : 400).json({
    success: false,
    message: tooLarge
      ? 'Image is too large. The maximum size is 2 MB.'
      : 'Too many files or fields in the upload.',
  });
};

module.exports = {
  upload,
  convertToJpg,
  handleUploadErrors,
};
