"use strict";

const binding = require("./build/Release/pxlib.node");

function open(path, options) {
  return new binding.Database(path, options);
}

module.exports = {
  ...binding,
  open,
};
