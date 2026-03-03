"use strict";

const path = require("path");
const { SqlDatabase } = require("../");

const tablePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "..", "..", "..", "assets", "tarticulos.DB");

const sql = `
  SELECT
    a.Codigo AS Codigo,
    a.DESCRIPCION AS Descripcion,
    b.CODIGO_FAMILIA AS Familia
  FROM articulos a
  INNER JOIN articulos b ON a.Codigo = b.Codigo
  WHERE a.Codigo <= 3
  ORDER BY a.Codigo ASC
  LIMIT 3
`;

for (const mode of ["materialized", "streaming", "sqlite"]) {
  const db = new SqlDatabase({
    mode,
    tables: {
      articulos: tablePath,
    },
  });

  try {
    console.log(JSON.stringify({
      mode,
      rows: db.query(sql),
    }, null, 2));
  } finally {
    db.close();
  }
}
