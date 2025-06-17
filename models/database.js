// models/database.js
const mysql = require('mysql2/promise');
const dbConfig = require('../config/db');
const pool = mysql.createPool(dbConfig); 
module.exports = {  
    pool // You might want to export the pool if you need more direct access
}; 