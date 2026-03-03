# pxlib Node.js bindings

This package builds a native Node.js addon around the pxlib C sources in this repository.

## Status

The addon is read-focused. It supports:

- opening `.DB` files
- optional blob file attachment
- reading schema metadata
- reading individual records or record ranges
- returning field values as JavaScript strings, numbers, booleans, `null`, or `Buffer`
- querying registered tables through a SQL facade with joins

It does not currently expose write/update APIs.

## Build

```bash
cd bindings/nodejs
npm install
npm run smoke
npm run sql-smoke
```

That runs `node-gyp rebuild` and compiles the addon against the bundled pxlib sources.

## Usage

```js
const pxlib = require("./");

const db = pxlib.open("example.db", {
  blobFile: "example.mb"
});

console.log(pxlib.version());
console.log(db.getInfo());
console.log(db.getFields());
console.log(db.getRecordCount());
console.log(db.getRecord(0));

db.close();
```

## SQL usage

```js
const path = require("path");
const pxlib = require("./");

const sql = new pxlib.SqlDatabase({
  mode: "sqlite",
  tables: {
    articulos: path.resolve("../../assets/tarticulos.DB"),
  },
});

const rows = sql.query(`
  SELECT a.Codigo, a.DESCRIPCION
  FROM articulos a
  INNER JOIN articulos b ON a.Codigo = b.Codigo
  WHERE a.Codigo <= 3
  ORDER BY a.Codigo ASC
`);

console.log(rows);
sql.close();
```

Supported SQL backends:

- `materialized`: loads the referenced tables into memory, then executes SQL in JavaScript
- `streaming`: scans rows from the addon and uses hashed equi-joins where possible
- `sqlite`: imports the registered tables into SQLite through Python's built-in `sqlite3` module, then runs the SQL there

Supported SQL subset for the JavaScript backends:

- `SELECT ... FROM ...`
- `INNER JOIN` and `LEFT JOIN`
- `WHERE` with `AND`
- comparison operators: `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
- `ORDER BY`
- `LIMIT` and `OFFSET`

## API

### `new Database(path, options?)`

`options` may include:

- `blobFile`
- `inputEncoding`
- `targetEncoding`

Note: this addon is compiled without iconv/recode/gsf support, so setting `inputEncoding` or `targetEncoding` will currently raise an error from pxlib.

### `open(path, options?)`

Convenience wrapper around `new Database(...)`.

### Instance methods

- `close()`
- `getInfo()`
- `getFields()`
- `getFieldCount()`
- `getRecordCount()`
- `getRecord(index)`
- `getRecords(start, count)`

### Exports

- `Database`
- `SqlDatabase`
- `createSqlDatabase()`
- `parseSql()`
- `constants`
- `version()`
- `open()`
