'use strict';

/**
 * Sends a standardised success response.
 * @param {import('express').Response} res
 * @param {*} data
 * @param {string} [message]
 * @param {number} [statusCode=200]
 */
function sendSuccess(res, data = null, message = 'Success', statusCode = 200) {
  const body = { success: true, message };
  if (data !== null && data !== undefined) body.data = data;
  return res.status(statusCode).json(body);
}

/**
 * Sends a standardised error response.
 * @param {import('express').Response} res
 * @param {string} message
 * @param {number} [statusCode=500]
 * @param {*} [errors]
 */
function sendError(res, message = 'An error occurred', statusCode = 500, errors = null) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

module.exports = { sendSuccess, sendError };
