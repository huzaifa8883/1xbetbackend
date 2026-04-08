'use strict';

function sendSuccess(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function sendError(res, message = 'Error', statusCode = 400) {
  return res.status(statusCode).json({ success: false, message });
}

module.exports = { sendSuccess, sendError };
