'use strict';

const jwt = require('jsonwebtoken');
const { ROLE_HIERARCHY } = require('../config/constants');
const { sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * JWT Authentication + optional role-based access control.
 *
 * @param {string|null} requiredRole  Minimum role required (inclusive)
 * @returns {import('express').RequestHandler}
 */
function authenticate(requiredRole = null) {
  return (req, res, next) => {
    // Accept token from Authorization header OR ?token= query param (for bundle0a.js compatibility)
    const authHeader = req.headers['authorization'];
    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.query.token) {
      token = req.query.token;
    } else {
      return sendError(res, 'Authentication token missing', 401);
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Validate essential fields
      if (!decoded.id || !decoded.role) {
        return sendError(res, 'Malformed token payload', 401);
      }

      req.user = decoded;

      // Role-based access check
      if (requiredRole) {
        const userLevel = ROLE_HIERARCHY[decoded.role] ?? 0;
        const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 0;

        if (userLevel < requiredLevel) {
          return sendError(res, 'Insufficient permissions', 403);
        }
      }

      return next();
    } catch (err) {
      logger.warn(`Auth failure: ${err.message}`);

      if (err.name === 'TokenExpiredError') {
        return sendError(res, 'Token has expired', 401);
      }
      return sendError(res, 'Invalid token', 401);
    }
  };
}

module.exports = authenticate;
