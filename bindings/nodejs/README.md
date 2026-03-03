# pxlib Node.js bindings

This package builds a native Node.js addon around the pxlib C sources in this repository.

## Status

The addon is read-focused. It supports:

- opening `.DB` files
- optional blob file attachment
- reading schema metadata
- reading individual records or record ranges
- returning field values as JavaScript strings, numbers, booleans, `null`, or `Buffer`

It does not currently expose write/update APIs.

## Build

```bash
cd bindings/nodejs
npm install
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
- `constants`
- `version()`
- `open()`
