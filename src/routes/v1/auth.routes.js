'use strict';

const { Router } = require('express');
const { login, me } = require('../../controllers/auth.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { loginRules } = require('../../validators');

const router = Router();

/**
 * @route   POST /api/v1/auth/login
 * @desc    Authenticate user and return JWT
 * @access  Public
 */
router.post('/login', loginRules, validate, login);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get currently authenticated user
 * @access  Private
 */
router.get('/me', authenticate(), me);

module.exports = router;
