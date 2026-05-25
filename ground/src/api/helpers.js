
/**

 * @param {number} statusCode - HTTP status code
 * @param {string} code - Machine-readable error code (e.g. 'OVERLAP')
 * @param {string} message - Human-readable message
 * @returns {Error}
 */
export function apiError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Async route wrapper catches rejected promises and forwards to error handler.
 * @param {Function} fn - Async route handler (req, res, next) => Promise
 * @returns {Function}
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}