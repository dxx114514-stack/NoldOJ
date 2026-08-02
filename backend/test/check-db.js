// Check admin user state in the database
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data', 'winoj.db');
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(data);

  // Check admin user
  const result = db.exec("SELECT id, username, nickname, role, banned, force_logout_at, rating, preferred_language FROM users WHERE username = 'admin'");
  if (result.length > 0) {
    const cols = result[0].columns;
    const vals = result[0].values[0];
    console.log('Admin user state:');
    cols.forEach((col, i) => {
      console.log(`  ${col}: ${vals[i]} (${typeof vals[i]})`);
    });
  } else {
    console.log('Admin user not found!');
  }

  // Check all users
  console.log('\nAll users:');
  const allUsers = db.exec("SELECT id, username, role, banned, force_logout_at FROM users ORDER BY id");
  if (allUsers.length > 0) {
    console.log('  ' + allUsers[0].columns.join(' | '));
    for (const row of allUsers[0].values) {
      console.log('  ' + row.join(' | '));
    }
  }

  // Check refresh tokens
  console.log('\nRefresh tokens:');
  const tokens = db.exec("SELECT * FROM refresh_tokens");
  if (tokens.length > 0) {
    console.log('  ' + tokens[0].columns.join(' | '));
    for (const row of tokens[0].values) {
      console.log('  ' + row.join(' | '));
    }
  } else {
    console.log('  (none)');
  }
}

main().catch(console.error);
