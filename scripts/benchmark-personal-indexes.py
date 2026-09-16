#!/usr/bin/env python3
"""Compare old JSON scans with migrated columns/indexes on disposable SQLite data."""
import argparse
import json
from pathlib import Path
import sqlite3
import statistics
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]

def measure(db, sql, args, repeats=15):
    db.execute(sql, args).fetchall()
    samples = []
    for _ in range(repeats):
        start = time.perf_counter()
        db.execute(sql, args).fetchall()
        samples.append((time.perf_counter() - start) * 1000)
    return round(statistics.median(samples), 3)

def run(rows):
    with tempfile.TemporaryDirectory(prefix="memos-index-benchmark-") as directory:
        db = sqlite3.connect(Path(directory) / "test.db")
        db.executescript((ROOT / "store/test/testdata/pre_personal_indexes/sqlite.sql").read_text())
        records = []
        for i in range(rows):
            payload = json.dumps({"space": f"space-{i // 5 % 10}", "isTodo": bool(i // 50 % 2), "tags": ["项目A"]}, ensure_ascii=False)
            records.append((f"memo-{i}", i % 5, 1700000000+i, 1700000000+(i*7919)%rows, i//100%2, "用于索引验证的正文，包含搜索词 tactus。"*10, payload))
        db.executemany("INSERT INTO memo(uid,creator_id,created_ts,updated_ts,pinned,content,payload) VALUES(?,?,?,?,?,?,?)", records)
        db.execute("INSERT INTO attachment(uid,creator_id,updated_ts,memo_id,payload) SELECT uid,creator_id,updated_ts,id,payload FROM memo WHERE id%4=0")
        db.execute("INSERT INTO memo_relation(memo_id,related_memo_id,type) SELECT id,(id%1000)+1,'REFERENCE' FROM memo WHERE id%5=0")
        db.commit()
        old_filter = "creator_id=? AND COALESCE(json_extract(payload,'$.space'),'')=? AND row_status=? AND COALESCE(json_extract(payload,'$.isTodo'),0)=?"
        new_filter = "creator_id=? AND space=? AND row_status=? AND is_todo=?"
        args = (1,"space-2","NORMAL",0)
        queries = []
        for order in ["created_ts DESC,id DESC", "updated_ts DESC,id DESC", "pinned DESC,created_ts DESC,id DESC", "pinned DESC,updated_ts DESC,id DESC"]:
            queries.append((order, f"SELECT id,content FROM memo WHERE {old_filter} ORDER BY {order} LIMIT 30", f"SELECT id,content FROM memo WHERE {new_filter} ORDER BY {order} LIMIT 30", args))
        queries += [
            ("scoped_content_search",f"SELECT id FROM memo WHERE {old_filter} AND content LIKE '%tactus%' ORDER BY created_ts DESC,id DESC LIMIT 30", f"SELECT id FROM memo WHERE {new_filter} AND content LIKE '%tactus%' ORDER BY created_ts DESC,id DESC LIMIT 30",args),
            ("attachments","SELECT id FROM attachment WHERE creator_id=? AND COALESCE(json_extract(payload,'$.space'),'')=? ORDER BY updated_ts DESC LIMIT 30","SELECT id FROM attachment WHERE creator_id=? AND space=? ORDER BY updated_ts DESC LIMIT 30",(1,"space-2")),
            ("references","SELECT memo_id FROM memo_relation WHERE related_memo_id=? AND type=? ORDER BY memo_id DESC","SELECT memo_id FROM memo_relation WHERE related_memo_id=? AND type=? ORDER BY memo_id DESC",(6,"REFERENCE")),
        ]
        before = {name: db.execute(old,args).fetchall() for name,old,new,args in queries}
        timings = {name:{"before_ms":measure(db,old,args)} for name,old,new,args in queries}
        bytes_before = db.execute("PRAGMA page_count").fetchone()[0]*db.execute("PRAGMA page_size").fetchone()[0]
        start = time.perf_counter()
        db.executescript((ROOT/"store/migration/sqlite/0.30/01__personal_content_indexes.sql").read_text())
        migration_ms = round((time.perf_counter()-start)*1000,3)
        db.execute("ANALYZE")
        for name,old,new,args in queries:
            assert before[name] == db.execute(new,args).fetchall(),name
            timings[name]["after_ms"] = measure(db,new,args)
            timings[name]["plan"] = [r[3] for r in db.execute("EXPLAIN QUERY PLAN "+new,args)]
        bytes_after = db.execute("PRAGMA page_count").fetchone()[0]*db.execute("PRAGMA page_size").fetchone()[0]
        indexes = db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' AND tbl_name IN ('memo','attachment','memo_relation')").fetchall()
        def write_batch():
            start=time.perf_counter()
            db.executemany("INSERT INTO memo(uid,creator_id,space,is_todo,content) VALUES(?,?,?,?,?)",[(f"write-{i}",1,"space-2",False,"写入验证") for i in range(1000)])
            db.commit()
            elapsed=round((time.perf_counter()-start)*1000,3)
            db.execute("DELETE FROM memo WHERE uid LIKE 'write-%'");db.commit()
            return elapsed
        indexed_write=write_batch()
        for name,_ in indexes: db.execute('DROP INDEX "'+name+'"')
        unindexed_write=write_batch()
        print(json.dumps({"rows":rows,"sqlite_version":sqlite3.sqlite_version,"migration_ms":migration_ms,"database_bytes_before":bytes_before,"database_bytes_after":bytes_after,"insert_1000_indexed_ms":indexed_write,"insert_1000_without_indexes_ms":unindexed_write,"queries":timings},ensure_ascii=False,indent=2))
        db.close()

if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows",type=int,default=100000)
    args=parser.parse_args()
    if args.rows < 1000: parser.error("--rows must be at least 1000")
    run(args.rows)
