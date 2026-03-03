"use strict";

const binding = require("./build/Release/pxlib.node");
const { SqlDatabase, createSqlDatabase, parseSql } = require("./lib/sql");

function open(path, options) {
  return new binding.Database(path, options);
}

module.exports = {
  Database: binding.Database,
  constants: binding.constants,
  version: binding.version,
  SqlDatabase,
  createSqlDatabase,
  parseSql,
  open,
};
