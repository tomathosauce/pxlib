"use strict";

const path = require("path");
const pxlib = require("../");

const inputPath = path.resolve(process.argv[2]);

const db = new pxlib.Database(inputPath);

try {
  const info = db.getInfo();
  const fields = db.getFields();
  const first = db.getRecord(0);

  console.log(JSON.stringify({
    path: inputPath,
    info,
    fieldPreview: fields.slice(0, 5),
    firstRecordPreview: Object.fromEntries(Object.entries(first).slice(0, 12)),
  }, null, 2));
} finally {
  db.close();
}
