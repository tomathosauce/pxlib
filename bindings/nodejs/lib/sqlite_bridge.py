import json
import sqlite3
import sys


def load_tables(db_path, payload_path):
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        for table_name, table in payload["tables"].items():
            columns = table["columns"]
            rows = table["rows"]

            cursor.execute(f'DROP TABLE IF EXISTS "{table_name}"')
            column_defs = ", ".join(f'"{column["name"]}" {column["sqliteType"]}' for column in columns)
            cursor.execute(f'CREATE TABLE "{table_name}" ({column_defs})')

            if rows:
                placeholders = ", ".join(["?"] * len(columns))
                column_names = ", ".join(f'"{column["name"]}"' for column in columns)
                insert_sql = f'INSERT INTO "{table_name}" ({column_names}) VALUES ({placeholders})'
                cursor.executemany(
                    insert_sql,
                    [[row.get(column["name"]) for column in columns] for row in rows],
                )
        conn.commit()
    finally:
        conn.close()


def query_tables(db_path, sql):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        rows = cursor.execute(sql).fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
    finally:
        conn.close()


def main():
    mode = sys.argv[1]
    if mode == "load":
        load_tables(sys.argv[2], sys.argv[3])
        return
    if mode == "query":
        query_tables(sys.argv[2], sys.argv[3])
        return
    raise SystemExit(f"Unknown mode: {mode}")


if __name__ == "__main__":
    main()
