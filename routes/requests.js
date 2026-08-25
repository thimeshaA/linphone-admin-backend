const express = require('express');
const { submitAccessRequest } = require('../controllers/requestsController');

const router = express.Router();

router.post('/', submitAccessRequest);

module.exports = router;
