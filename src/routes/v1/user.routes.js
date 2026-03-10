'use strict';

const { Router } = require('express');
const ctrl = require('../../controllers/user.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { createUserRules, transactionRules, creditTransactionRules } = require('../../validators');
const { ROLES } = require('../../config/constants');

const router = Router();

// All user routes require authentication
router.use(authenticate());

/**
 * @route   GET /api/v1/users
 * @desc    List all users — optional ?role= filter (Admin+)
 */
router.get('/', authenticate(ROLES.ADMIN), ctrl.listUsers);

/**
 * @route   GET /api/v1/users/masters
 * @desc    List all Master users (SuperAdmin / Admin)
 */
router.get('/masters', ctrl.listByRole('Master'));

/**
 * @route   GET /api/v1/users/supermasters
 * @desc    List all SuperMaster users
 */
router.get('/supermasters', ctrl.listByRole('SuperMaster'));

/**
 * @route   GET /api/v1/users/admin
 * @desc    List all Admin users
 */
router.get('/admin', ctrl.listByRole('Admin'));

/**
 * @route   GET /api/v1/users/user
 * @desc    List all regular User accounts
 */
router.get('/user', ctrl.listByRole('User'));

/**
 * @route   POST /api/v1/users        — standard create
 * @route   POST /api/v1/users/create — legacy alias (Admin.html)
 */
router.post('/', createUserRules, validate, ctrl.createUser);
router.post('/create', createUserRules, validate, ctrl.createUser);

/**
 * @route   GET /api/v1/users/me
 * @desc    Get profile of currently logged-in user
 */
router.get('/me', ctrl.getMe);

/**
 * @route   GET /api/v1/users/downline
 * @desc    Get direct children of current user (or by parentId query)
 */
router.get('/downline', ctrl.getDownline);

/**
 * @route   POST /api/v1/users/transaction
 * @desc    Deposit / withdrawal between users
 */
router.post('/transaction', transactionRules, validate, ctrl.processTransaction);

/**
 * @route   POST /api/v1/users/credit-transaction
 * @desc    Credit deposit / withdrawal
 */
router.post('/credit-transaction', creditTransactionRules, validate, ctrl.processCreditTransaction);

/**
 * @route   GET /api/v1/users/:id/transactions
 * @desc    Get transaction history for a user
 */
router.get('/:id/transactions', ctrl.getUserTransactions);

/**
 * @route   GET /api/v1/users/:id
 * @desc    Get user by ID
 */
router.get('/:id', ctrl.getUser);

/**
 * @route   PUT /api/v1/users/:id
 * @desc    Update user
 */
router.put('/:id', ctrl.updateUser);

/**
 * @route   DELETE /api/v1/users/:id
 * @desc    Delete user (Admin+)
 */
router.delete('/:id', authenticate(ROLES.ADMIN), ctrl.deleteUser);

module.exports = router;
