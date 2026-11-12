const { openDatabase, DEFAULT_DB_PATH } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');

const db = openDatabase();
seedTemporaryData(db);
console.log(`Temporary catalog and shipping data ready at ${DEFAULT_DB_PATH}`);
db.close();