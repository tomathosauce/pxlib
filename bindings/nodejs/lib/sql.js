"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const binding = require("../build/Release/pxlib.node");

const TOKEN_REGEX = /\s+|--.*?$|\/\*[\s\S]*?\*\/|<=|>=|<>|!=|=|<|>|\*|,|\.|\(|\)|"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?/gms;
const SQL_KEYWORDS = new Set([
  "AS",
  "SELECT",
  "FROM",
  "INNER",
  "LEFT",
  "JOIN",
  "ON",
  "WHERE",
  "AND",
  "ORDER",
  "BY",
  "LIMIT",
  "OFFSET",
  "ASC",
  "DESC",
  "TRUE",
  "FALSE",
  "NULL",
]);

function open(pathname, options) {
  return new binding.Database(pathname, options);
}

function createSqlDatabase(config) {
  return new SqlDatabase(config);
}

function tokenize(sql) {
  const tokens = [];
  for (const match of sql.matchAll(TOKEN_REGEX)) {
    const value = match[0];
    if (!value.trim() || value.startsWith("--") || value.startsWith("/*")) {
      continue;
    }
    tokens.push(value);
  }
  return tokens;
}

function normalizeIdentifier(token) {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  return token;
}

function parseStringLiteral(token) {
  return token.slice(1, -1).replace(/''/g, "'");
}

class TokenCursor {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  next() {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  isKeyword(token, keyword) {
    return typeof token === "string" && token.toUpperCase() === keyword;
  }

  expectKeyword(keyword) {
    const token = this.next();
    if (!this.isKeyword(token, keyword)) {
      throw new Error(`Expected keyword ${keyword}`);
    }
  }

  consumeKeyword(keyword) {
    if (this.isKeyword(this.peek(), keyword)) {
      this.next();
      return true;
    }
    return false;
  }

  expectSymbol(symbol) {
    const token = this.next();
    if (token !== symbol) {
      throw new Error(`Expected '${symbol}'`);
    }
  }

  consumeSymbol(symbol) {
    if (this.peek() === symbol) {
      this.next();
      return true;
    }
    return false;
  }

  expectIdentifier() {
    const token = this.next();
    if (!token) {
      throw new Error("Expected identifier");
    }
    if (SQL_KEYWORDS.has(token.toUpperCase())) {
      throw new Error(`Expected identifier, got keyword ${token}`);
    }
    if (!/^"(?:[^"]|"")*"$/.test(token) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      throw new Error(`Invalid identifier '${token}'`);
    }
    return normalizeIdentifier(token);
  }
}

function parseOperand(cursor) {
  const token = cursor.peek();
  if (!token) {
    throw new Error("Unexpected end of SQL");
  }

  if (/^\d+(?:\.\d+)?$/.test(token)) {
    cursor.next();
    return { type: "literal", value: Number(token) };
  }
  if (/^'(?:[^']|'')*'$/.test(token)) {
    cursor.next();
    return { type: "literal", value: parseStringLiteral(token) };
  }
  if (cursor.isKeyword(token, "TRUE")) {
    cursor.next();
    return { type: "literal", value: true };
  }
  if (cursor.isKeyword(token, "FALSE")) {
    cursor.next();
    return { type: "literal", value: false };
  }
  if (cursor.isKeyword(token, "NULL")) {
    cursor.next();
    return { type: "literal", value: null };
  }

  const first = cursor.expectIdentifier();
  if (cursor.consumeSymbol(".")) {
    return {
      type: "column",
      table: first,
      column: cursor.expectIdentifier(),
    };
  }

  return {
    type: "column",
    table: null,
    column: first,
  };
}

function parseSelectItem(cursor) {
  if (cursor.consumeSymbol("*")) {
    return { type: "all", table: null, alias: null };
  }

  const first = cursor.expectIdentifier();
  let table = null;
  let column = first;
  let isAll = false;

  if (cursor.consumeSymbol(".")) {
    table = first;
    if (cursor.consumeSymbol("*")) {
      isAll = true;
      column = "*";
    } else {
      column = cursor.expectIdentifier();
    }
  }

  let alias = null;
  if (cursor.consumeKeyword("AS")) {
    alias = cursor.expectIdentifier();
  } else if (cursor.peek()) {
    const token = cursor.peek();
    if (!["FROM", "INNER", "LEFT", "WHERE", "ORDER", "LIMIT", "OFFSET", "JOIN", "ON", ","].includes((token || "").toUpperCase())) {
      alias = cursor.expectIdentifier();
    }
  }

  if (isAll) {
    return { type: "all", table, alias };
  }

  return {
    type: "column",
    table,
    column,
    alias,
  };
}

function parseTableSpec(cursor) {
  const name = cursor.expectIdentifier();
  let alias = name;
  if (cursor.consumeKeyword("AS")) {
    alias = cursor.expectIdentifier();
  } else {
    const token = cursor.peek();
    if (token && !["INNER", "LEFT", "JOIN", "ON", "WHERE", "ORDER", "LIMIT", "OFFSET", ","].includes(token.toUpperCase())) {
      alias = cursor.expectIdentifier();
    }
  }
  return { name, alias };
}

function parseCondition(cursor) {
  const left = parseOperand(cursor);
  const operator = cursor.next();
  if (!["=", "!=", "<>", "<", "<=", ">", ">="].includes(operator)) {
    throw new Error(`Unsupported operator '${operator}'`);
  }
  const right = parseOperand(cursor);
  return { left, operator, right };
}

function parseOrderBy(cursor) {
  const operand = parseOperand(cursor);
  let direction = "ASC";
  if (cursor.consumeKeyword("ASC")) {
    direction = "ASC";
  } else if (cursor.consumeKeyword("DESC")) {
    direction = "DESC";
  }
  return { operand, direction };
}

function parseSql(sql) {
  const cursor = new TokenCursor(tokenize(sql));
  cursor.expectKeyword("SELECT");

  const select = [];
  do {
    select.push(parseSelectItem(cursor));
  } while (cursor.consumeSymbol(","));

  cursor.expectKeyword("FROM");
  const from = parseTableSpec(cursor);

  const joins = [];
  while (cursor.isKeyword(cursor.peek(), "INNER") || cursor.isKeyword(cursor.peek(), "LEFT") || cursor.isKeyword(cursor.peek(), "JOIN")) {
    let joinType = "INNER";
    if (cursor.consumeKeyword("INNER")) {
      joinType = "INNER";
      cursor.expectKeyword("JOIN");
    } else if (cursor.consumeKeyword("LEFT")) {
      joinType = "LEFT";
      cursor.expectKeyword("JOIN");
    } else {
      cursor.expectKeyword("JOIN");
    }
    const table = parseTableSpec(cursor);
    cursor.expectKeyword("ON");
    const on = parseCondition(cursor);
    joins.push({ type: joinType, table, on });
  }

  const where = [];
  if (cursor.consumeKeyword("WHERE")) {
    do {
      where.push(parseCondition(cursor));
    } while (cursor.consumeKeyword("AND"));
  }

  const orderBy = [];
  if (cursor.consumeKeyword("ORDER")) {
    cursor.expectKeyword("BY");
    do {
      orderBy.push(parseOrderBy(cursor));
    } while (cursor.consumeSymbol(","));
  }

  let limit = null;
  if (cursor.consumeKeyword("LIMIT")) {
    limit = Number(cursor.next());
    if (!Number.isFinite(limit)) {
      throw new Error("LIMIT must be numeric");
    }
  }

  let offset = 0;
  if (cursor.consumeKeyword("OFFSET")) {
    offset = Number(cursor.next());
    if (!Number.isFinite(offset)) {
      throw new Error("OFFSET must be numeric");
    }
  }

  if (cursor.peek()) {
    throw new Error(`Unexpected token '${cursor.peek()}'`);
  }

  return { select, from, joins, where, orderBy, limit, offset };
}

function collectOperandAliases(operand) {
  if (operand.type !== "column" || !operand.table) {
    return [];
  }
  return [operand.table];
}

function collectConditionAliases(condition) {
  return [...new Set([
    ...collectOperandAliases(condition.left),
    ...collectOperandAliases(condition.right),
  ])];
}

function conditionsForAliases(conditions, aliases) {
  const allowed = new Set(aliases);
  return conditions.filter((condition) => {
    const referenced = collectConditionAliases(condition);
    return referenced.every((alias) => allowed.has(alias));
  });
}

function buildJoinLookupInfo(join, availableAliases) {
  if (join.on.operator !== "=") {
    return null;
  }

  const available = new Set(availableAliases);
  const joinAlias = join.table.alias;
  const left = join.on.left;
  const right = join.on.right;

  if (left.type === "column" && right.type === "column") {
    if (left.table === joinAlias && right.table && available.has(right.table)) {
      return {
        joinColumn: left.column,
        contextOperand: right,
      };
    }
    if (right.table === joinAlias && left.table && available.has(left.table)) {
      return {
        joinColumn: right.column,
        contextOperand: left,
      };
    }
  }
  return null;
}

function compareValues(left, operator, right) {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
    case "<>":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      throw new Error(`Unsupported operator '${operator}'`);
  }
}

function resolveColumn(context, operand) {
  if (operand.table) {
    const row = context[operand.table];
    return row ? row[operand.column] : null;
  }

  const matches = [];
  for (const row of Object.values(context)) {
    if (row && Object.prototype.hasOwnProperty.call(row, operand.column)) {
      matches.push(row[operand.column]);
    }
  }
  if (matches.length === 0) {
    throw new Error(`Unknown column '${operand.column}'`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous column '${operand.column}'`);
  }
  return matches[0];
}

function resolveOperand(context, operand) {
  if (operand.type === "literal") {
    return operand.value;
  }
  return resolveColumn(context, operand);
}

function matchesConditions(context, conditions) {
  return conditions.every((condition) => compareValues(
    resolveOperand(context, condition.left),
    condition.operator,
    resolveOperand(context, condition.right),
  ));
}

function projectRow(parsed, context) {
  const row = {};
  for (const item of parsed.select) {
    if (item.type === "all") {
      if (item.table) {
        Object.assign(row, context[item.table] || {});
      } else {
        for (const source of Object.values(context)) {
          Object.assign(row, source || {});
        }
      }
      continue;
    }

    const value = resolveOperand(context, { type: "column", table: item.table, column: item.column });
    row[item.alias || item.column] = value;
  }
  return row;
}

function applyOrderLimit(rows, parsed) {
  if (parsed.orderBy.length > 0) {
    rows.sort((left, right) => {
      for (const item of parsed.orderBy) {
        const leftValue = resolveOperand({ result: left, ...left.__context }, item.operand.type === "column" && !item.operand.table
          ? { ...item.operand, table: "result" }
          : item.operand);
        const rightValue = resolveOperand({ result: right, ...right.__context }, item.operand.type === "column" && !item.operand.table
          ? { ...item.operand, table: "result" }
          : item.operand);
        if (leftValue === rightValue) {
          continue;
        }
        if (leftValue == null) {
          return item.direction === "ASC" ? -1 : 1;
        }
        if (rightValue == null) {
          return item.direction === "ASC" ? 1 : -1;
        }
        if (leftValue < rightValue) {
          return item.direction === "ASC" ? -1 : 1;
        }
        return item.direction === "ASC" ? 1 : -1;
      }
      return 0;
    });
  }

  const start = parsed.offset || 0;
  const end = parsed.limit == null ? undefined : start + parsed.limit;
  return rows.slice(start, end).map((row) => {
    delete row.__context;
    return row;
  });
}

function filterRowsByConditions(rows, alias, conditions) {
  if (conditions.length === 0) {
    return rows;
  }
  return rows.filter((row) => matchesConditions({ [alias]: row }, conditions));
}

function buildHashIndex(rows, column) {
  const index = new Map();
  for (const row of rows) {
    const key = row ? row[column] : null;
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(row);
  }
  return index;
}

function mapFieldToSqliteType(field) {
  switch (field.type) {
    case binding.constants.pxfAlpha:
    case binding.constants.pxfBCD:
      return "TEXT";
    case binding.constants.pxfLogical:
    case binding.constants.pxfShort:
    case binding.constants.pxfLong:
    case binding.constants.pxfDate:
    case binding.constants.pxfTime:
    case binding.constants.pxfAutoInc:
      return "INTEGER";
    case binding.constants.pxfBytes:
    case binding.constants.pxfGraphic:
    case binding.constants.pxfBLOb:
    case binding.constants.pxfFmtMemoBLOb:
    case binding.constants.pxfMemoBLOb:
    case binding.constants.pxfOLE:
      return "BLOB";
    default:
      return "REAL";
  }
}

class TableRegistry {
  constructor(tables, options = {}) {
    this.options = options;
    this.tables = new Map();
    for (const [name, source] of Object.entries(tables || {})) {
      this.tables.set(name, {
        name,
        path: typeof source === "string" ? source : source.path,
        options: typeof source === "string" ? {} : { ...source },
        db: null,
      });
    }
  }

  getTable(name) {
    const entry = this.tables.get(name);
    if (!entry) {
      throw new Error(`Unknown table '${name}'`);
    }
    if (!entry.db) {
      const { path: tablePath, options } = entry;
      entry.db = open(path.resolve(tablePath), options);
    }
    return entry;
  }

  getRowCount(name) {
    return this.getTable(name).db.getRecordCount();
  }

  getRow(name, index) {
    return this.getTable(name).db.getRecord(index);
  }

  getRows(name, start, count) {
    return this.getTable(name).db.getRecords(start, count);
  }

  getFields(name) {
    return this.getTable(name).db.getFields();
  }

  close() {
    for (const entry of this.tables.values()) {
      if (entry.db) {
        entry.db.close();
        entry.db = null;
      }
    }
  }
}

class MaterializedBackend {
  constructor(registry) {
    this.registry = registry;
  }

  materializeTable(name) {
    const count = this.registry.getRowCount(name);
    const rows = [];
    for (let start = 0; start < count; start += 250) {
      rows.push(...this.registry.getRows(name, start, Math.min(250, count - start)));
    }
    return rows;
  }

  query(parsed) {
    const tableRows = new Map();
    const aliasFilters = new Map();
    aliasFilters.set(parsed.from.alias, conditionsForAliases(parsed.where, [parsed.from.alias]));
    for (const join of parsed.joins) {
      aliasFilters.set(join.table.alias, conditionsForAliases(parsed.where, [join.table.alias]));
    }

    const getRows = (name) => {
      if (!tableRows.has(name)) {
        tableRows.set(name, this.materializeTable(name));
      }
      return tableRows.get(name);
    };

    let contexts = filterRowsByConditions(getRows(parsed.from.name), parsed.from.alias, aliasFilters.get(parsed.from.alias))
      .map((row) => ({ [parsed.from.alias]: row }));
    let availableAliases = [parsed.from.alias];

    for (const join of parsed.joins) {
      const joinedRows = filterRowsByConditions(getRows(join.table.name), join.table.alias, aliasFilters.get(join.table.alias));
      const lookup = buildJoinLookupInfo(join, availableAliases);
      const next = [];
      if (lookup) {
        const index = buildHashIndex(joinedRows, lookup.joinColumn);
        for (const context of contexts) {
          const key = resolveOperand(context, lookup.contextOperand);
          const matches = index.get(key) || [];
          if (matches.length > 0) {
            for (const row of matches) {
              next.push({ ...context, [join.table.alias]: row });
            }
          } else if (join.type === "LEFT") {
            next.push({ ...context, [join.table.alias]: null });
          }
        }
      } else {
        for (const context of contexts) {
          let matched = false;
          for (const row of joinedRows) {
            const merged = { ...context, [join.table.alias]: row };
            if (matchesConditions(merged, [join.on])) {
              matched = true;
              next.push(merged);
            }
          }
          if (!matched && join.type === "LEFT") {
            next.push({ ...context, [join.table.alias]: null });
          }
        }
      }
      contexts = next;
      availableAliases.push(join.table.alias);
    }

    const postWhere = parsed.where.filter((condition) => {
      const aliases = collectConditionAliases(condition);
      return aliases.length === 0 || aliases.length > 1 || !aliasFilters.has(aliases[0]);
    });
    const rows = [];
    for (const context of contexts) {
      if (!matchesConditions(context, postWhere)) {
        continue;
      }
      const projected = projectRow(parsed, context);
      projected.__context = context;
      rows.push(projected);
    }
    return applyOrderLimit(rows, parsed);
  }
}

class StreamingBackend {
  constructor(registry) {
    this.registry = registry;
  }

  query(parsed) {
    const aliasFilters = new Map();
    aliasFilters.set(parsed.from.alias, conditionsForAliases(parsed.where, [parsed.from.alias]));
    for (const join of parsed.joins) {
      aliasFilters.set(join.table.alias, conditionsForAliases(parsed.where, [join.table.alias]));
    }

    const joinIndexes = new Map();
    let availableAliases = [parsed.from.alias];
    for (const join of parsed.joins) {
      const lookup = buildJoinLookupInfo(join, availableAliases);
      if (lookup) {
        const count = this.registry.getRowCount(join.table.name);
        const rowsForIndex = [];
        for (let i = 0; i < count; i += 1) {
          rowsForIndex.push(this.registry.getRow(join.table.name, i));
        }
        const filtered = filterRowsByConditions(rowsForIndex, join.table.alias, aliasFilters.get(join.table.alias));
        joinIndexes.set(join.table.alias, {
          lookup,
          index: buildHashIndex(filtered, lookup.joinColumn),
        });
      }
      availableAliases.push(join.table.alias);
    }

    const postWhere = parsed.where.filter((condition) => {
      const aliases = collectConditionAliases(condition);
      return aliases.length === 0 || aliases.length > 1 || !aliasFilters.has(aliases[0]);
    });
    const rows = [];
    const walk = (contexts, joinIndex, currentAliases) => {
      if (joinIndex >= parsed.joins.length) {
        if (matchesConditions(contexts, postWhere)) {
          const projected = projectRow(parsed, contexts);
          projected.__context = contexts;
          rows.push(projected);
        }
        return;
      }

      const join = parsed.joins[joinIndex];
      const indexedJoin = joinIndexes.get(join.table.alias);
      if (indexedJoin) {
        const key = resolveOperand(contexts, indexedJoin.lookup.contextOperand);
        const matches = indexedJoin.index.get(key) || [];
        if (matches.length > 0) {
          for (const row of matches) {
            walk({ ...contexts, [join.table.alias]: row }, joinIndex + 1, [...currentAliases, join.table.alias]);
          }
          return;
        }
        if (join.type === "LEFT") {
          walk({ ...contexts, [join.table.alias]: null }, joinIndex + 1, [...currentAliases, join.table.alias]);
        }
        return;
      }

      const count = this.registry.getRowCount(join.table.name);
      let matched = false;
      for (let i = 0; i < count; i += 1) {
        const row = this.registry.getRow(join.table.name, i);
        if (!matchesConditions({ [join.table.alias]: row }, aliasFilters.get(join.table.alias))) {
          continue;
        }
        const merged = { ...contexts, [join.table.alias]: row };
        if (matchesConditions(merged, [join.on])) {
          matched = true;
          walk(merged, joinIndex + 1, [...currentAliases, join.table.alias]);
        }
      }
      if (!matched && join.type === "LEFT") {
        walk({ ...contexts, [join.table.alias]: null }, joinIndex + 1, [...currentAliases, join.table.alias]);
      }
    };

    const baseCount = this.registry.getRowCount(parsed.from.name);
    for (let i = 0; i < baseCount; i += 1) {
      const row = this.registry.getRow(parsed.from.name, i);
      if (!matchesConditions({ [parsed.from.alias]: row }, aliasFilters.get(parsed.from.alias))) {
        continue;
      }
      walk({ [parsed.from.alias]: row }, 0, [parsed.from.alias]);
    }

    return applyOrderLimit(rows, parsed);
  }
}

class SqliteBackend {
  constructor(registry) {
    this.registry = registry;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxlib-sql-"));
    this.dbPath = path.join(this.tempDir, "tables.sqlite");
    this.initialized = false;
  }

  getPythonCommand() {
    const override = process.env.PXLIB_NODE_PYTHON;
    if (override) {
      return { command: override, args: [] };
    }
    if (process.platform === "win32") {
      return { command: "py", args: ["-3"] };
    }
    return { command: "python3", args: [] };
  }

  runPython(args, options = {}) {
    const command = this.getPythonCommand();
    const result = spawnSync(command.command, [...command.args, path.join(__dirname, "sqlite_bridge.py"), ...args], {
      encoding: "utf8",
      ...options,
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "Python sqlite bridge failed").trim());
    }
    return result;
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    const payload = { tables: {} };
    for (const [name] of this.registry.tables) {
      const fields = this.registry.getFields(name);
      const count = this.registry.getRowCount(name);
      const rows = [];
      for (let start = 0; start < count; start += 250) {
        rows.push(...this.registry.getRows(name, start, Math.min(250, count - start)));
      }
      payload.tables[name] = {
        columns: fields.map((field) => ({
          name: field.name,
          sqliteType: mapFieldToSqliteType(field),
        })),
        rows,
      };
    }

    const payloadPath = path.join(this.tempDir, "payload.json");
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    this.runPython(["load", this.dbPath, payloadPath]);
    this.initialized = true;
  }

  query(sql) {
    this.initialize();
    const result = this.runPython(["query", this.dbPath, sql]);
    return JSON.parse(result.stdout || "[]");
  }

  close() {
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }
}

class SqlDatabase {
  constructor(config = {}) {
    this.mode = config.mode || "materialized";
    this.registry = new TableRegistry(config.tables, config.tableOptions);
    this.backends = new Map();
  }

  getBackend(mode) {
    const selectedMode = mode || this.mode;
    if (!this.backends.has(selectedMode)) {
      switch (selectedMode) {
        case "materialized":
          this.backends.set(selectedMode, new MaterializedBackend(this.registry));
          break;
        case "streaming":
          this.backends.set(selectedMode, new StreamingBackend(this.registry));
          break;
        case "sqlite":
          this.backends.set(selectedMode, new SqliteBackend(this.registry));
          break;
        default:
          throw new Error(`Unsupported SQL mode '${selectedMode}'`);
      }
    }
    return this.backends.get(selectedMode);
  }

  query(sql, options = {}) {
    const mode = options.mode || this.mode;
    const parsed = parseSql(sql);
    this.registry.getTable(parsed.from.name);
    for (const join of parsed.joins) {
      this.registry.getTable(join.table.name);
    }
    const backend = this.getBackend(mode);
    return mode === "sqlite" ? backend.query(sql) : backend.query(parsed);
  }

  close() {
    for (const backend of this.backends.values()) {
      if (typeof backend.close === "function") {
        backend.close();
      }
    }
    this.registry.close();
  }
}

module.exports = {
  SqlDatabase,
  createSqlDatabase,
  parseSql,
};
