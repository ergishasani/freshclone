import sqlite3
with sqlite3.connect('app.sqlite3') as database:
    database.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)')
print('migration-complete')
