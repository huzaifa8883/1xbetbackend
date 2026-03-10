'use strict';

const { body, param, query } = require('express-validator');
const { ROLES, TRANSACTION_TYPE } = require('../config/constants');

/* ── Auth ────────────────────────────────────────────────── */
const loginRules = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

/* ── User ────────────────────────────────────────────────── */
const createUserRules = [
  body('username').trim().isLength({ min: 3, max: 60 }).withMessage('Username must be 3–60 chars'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(Object.values(ROLES)).withMessage('Invalid role'),
  body('initial_balance').optional().isFloat({ min: 0 }).withMessage('Balance must be ≥ 0'),
];

const transactionRules = [
  body('type').isIn([TRANSACTION_TYPE.DEPOSIT, TRANSACTION_TYPE.WITHDRAWAL]).withMessage('Invalid type'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be positive'),
  body('userId').customSanitizer(v => parseInt(v, 10)).isInt({ min: 1 }).withMessage('userId must be a positive integer'),
  body('description').trim().notEmpty().withMessage('Description required'),
];

const creditTransactionRules = [
  body('type').isIn([TRANSACTION_TYPE.CREDIT_DEPOSIT, TRANSACTION_TYPE.CREDIT_WITHDRAWAL]).withMessage('Invalid type'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be positive'),
  body('userId').customSanitizer(v => parseInt(v, 10)).isInt({ min: 1 }).withMessage('userId must be a positive integer'),
  body('description').trim().notEmpty().withMessage('Description required'),
];

/* ── Orders ──────────────────────────────────────────────── */
const placeBetRules = [
  body('*.marketId').notEmpty().withMessage('marketId required'),
  body('*.selectionId').isInt({ min: 1 }).withMessage('selectionId must be a positive integer'),
  body('*.side').isIn(['B', 'L']).withMessage('side must be B or L'),
  body('*.price').isFloat({ min: 1.01 }).withMessage('price must be ≥ 1.01'),
  body('*.size').isFloat({ min: 0.01 }).withMessage('size must be positive'),
];

module.exports = {
  loginRules,
  createUserRules,
  transactionRules,
  creditTransactionRules,
  placeBetRules,
};
