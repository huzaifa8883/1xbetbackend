'use strict';

const { validationResult } = require('express-validator');
const { sendError } = require('../utils/response');

/**
 * Run after express-validator chains.
 * Returns 400 with field-level errors if any validation failed.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, 'Validation failed', 400, errors.array());
  }
  return next();
}

module.exports = validate;
