#!/usr/bin/env node
import { ready, connectClient, OPFSStorageProvider, ObjectId, Pointer } from '../wasm/nisaba-wasm.js';

// Set up node-opfs for Node.js environment
try {
  const nodeOpfs = await import('node-opfs');
  if (nodeOpfs.navigator && typeof global !== 'undefined') {
    Object.defineProperty(global, 'navigator', {
      value: nodeOpfs.navigator,
      writable: true,
      configurable: true
    });
  }
} catch (e) {
  console.error('Error: node-opfs is required to run this tool in Node.js');
  console.error('Install it with: npm install node-opfs');
  process.exit(1);
}

function usage() {
  console.error(`Usage: db <name> <command> [args] [options]

A document database. <name> selects (creating if needed) an OPFS
subdirectory holding its catalog and collection/index files.

Database commands:
  collections                            List collection names (default)
  drop-collection <coll>                 Drop a collection and its indexes
  compact [coll]                         Rewrite a collection's files (all
                                         collections if omitted) without their
                                         append-only history, reclaiming space

Document commands:
  insert <coll> <doc>                    Insert one document
  insert-many <coll> <docs>              Insert an array of documents
  find <coll> [filter]                   Find matching documents ({} if omitted)
  find-one <coll> [filter]               Find the first matching document
  count <coll> [filter]                  Count matching documents
  distinct <coll> <field> [filter]       Unique values of a field across matches
  delete-one <coll> [filter]             Delete the first matching document
  delete-many <coll> [filter]            Delete every matching document
  replace-one <coll> <filter> <doc>      Replace the first matching document
  update-one <coll> <filter> <update>    Apply update operators to the first match
  update-many <coll> <filter> <update>   Apply update operators to every match
  find-one-and-update <coll> <filter> <update>
                                          Atomically update and return a document
  find-one-and-replace <coll> <filter> <doc>
                                          Atomically replace and return a document
  find-one-and-delete <coll> [filter]    Atomically delete and return a document
  bulk-write <coll> <operations>         Mixed insert/update/delete in one call
  watch <coll>                           Stream change events until Ctrl+C

Index commands:
  create-index <coll> <keys>             e.g. create-index users '{"team":1}'
  drop-index <coll> <indexName>          Drop an index
  list-indexes <coll>                    List a collection's indexes
  find-by-index <coll> <indexName> <values>
                                          e.g. find-by-index users team_1 '["core"]'
  prune-expired <coll>                   Delete documents past a TTL index's cutoff

<doc>/<filter>/<keys>/<values>/<docs>/<operations> are JSON. ObjectId and
Date literals use MongoDB Extended JSON: {"$oid":"<24 hex chars>"} and
{"$date":"<ISO 8601>"}. The full query-operator, update-operator, and
bulk-write shapes are documented in docs/db-api.md -- a few examples:

  '{"age":{"$gt":30}}'                                query operator
  '{"$set":{"team":"core"},"$inc":{"visits":1}}'      update operators
  '[{"insertOne":{"document":{"name":"Ada"}}}]'       bulk-write operation

update-one/update-many/find-one-and-update reject a plain replacement
document -- use replace-one/find-one-and-replace for that.

Options:
  --sort <json>       find: sort spec, e.g. '{"age":1}' or '{"age":-1}'
  --skip <n>          find: number of matches to skip
  --limit <n>         find: max matches to return
  --project <json>    find: projection spec, e.g. '{"name":1}' or '{"age":0}'
  --upsert            replace-one/update-one/update-many/find-one-and-update/
                      find-one-and-replace: insert if nothing matched
  --return-document <before|after>
                      find-one-and-update/find-one-and-replace: which image
                      to return (default before)
  --unordered         insert-many/bulk-write: don't stop at the first failure
  --name <name>       create-index: index name (default: "field_1[_field2_1...]")
  --unique            create-index: reject a duplicate value
  --sparse            create-index: don't index documents missing the field
  --partial-filter <json>
                      create-index: only index documents matching this filter
  --ttl <seconds>     create-index: expireAfterSeconds (single-field index only)
  --order <n>         B+ tree order for newly created files (default 32, min 3)
  -h, --help          Show this help`);
  process.exit(1);
}

function formatValue(value) {
  const indentUnit = '  ';
  const render = (val, depth) => {
    const pad = indentUnit.repeat(depth);
    const nextPad = indentUnit.repeat(depth + 1);

    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (typeof val === 'string') return JSON.stringify(val);

    if (val instanceof Pointer) return `Pointer(${val.valueOf()})`;
    if (val instanceof ObjectId) {
      return `ObjectId(${val.toHexString ? val.toHexString() : val.toString()})`;
    }
    if (val instanceof Date) return `Date(${val.toISOString()})`;

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const inner = val.map(item => `${nextPad}${render(item, depth + 1)}`).join('\n');
      return `[\n${inner}\n${pad}]`;
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val);
      if (entries.length === 0) return '{}';
      const inner = entries
        .map(([k, v]) => `${nextPad}${k}: ${render(v, depth + 1)}`)
        .join('\n');
      return `{\n${inner}\n${pad}}`;
    }

    return JSON.stringify(val);
  };

  return render(value, 0);
}

function printDocs(docs, noun = 'document') {
  if (docs.length === 0) {
    console.log(`No ${noun}s found.`);
    return;
  }
  for (let i = 0; i < docs.length; i++) {
    console.log(`${i}: ${formatValue(docs[i])}`);
  }
}

/** JSON.parse with MongoDB Extended JSON's {$oid} / {$date} literals. */
function parseJson(label, str) {
  try {
    return JSON.parse(str, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$oid' && typeof value.$oid === 'string') {
          return new ObjectId(value.$oid);
        }
        if (keys.length === 1 && keys[0] === '$date' && typeof value.$date === 'string') {
          return new Date(value.$date);
        }
      }
      return value;
    });
  } catch (err) {
    console.error(`Error: ${label} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const opts = { order: 32 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
    } else if (arg === '--upsert') {
      opts.upsert = true;
    } else if (arg === '--unordered') {
      opts.ordered = false;
    } else if (arg === '--sort') {
      opts.sort = parseJson('--sort', argv[++i]);
    } else if (arg === '--project') {
      opts.project = parseJson('--project', argv[++i]);
    } else if (arg === '--skip') {
      opts.skip = Number(argv[++i]);
    } else if (arg === '--limit') {
      opts.limit = Number(argv[++i]);
    } else if (arg === '--return-document') {
      const v = argv[++i];
      if (v !== 'before' && v !== 'after') {
        console.error('Error: --return-document must be "before" or "after"');
        process.exit(1);
      }
      opts.returnDocument = v;
    } else if (arg === '--name') {
      opts.name = argv[++i];
    } else if (arg === '--unique') {
      opts.unique = true;
    } else if (arg === '--sparse') {
      opts.sparse = true;
    } else if (arg === '--partial-filter') {
      opts.partialFilter = parseJson('--partial-filter', argv[++i]);
    } else if (arg === '--ttl') {
      opts.ttl = Number(argv[++i]);
    } else if (arg === '--order') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 3) {
        console.error('Error: --order must be an integer >= 3');
        process.exit(1);
      }
      opts.order = n;
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function requireArgs(args, n, message) {
  if (args.length < n) {
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));

  const dbName = positional[0];
  if (!dbName) usage();

  const command = (positional[1] || 'collections').toLowerCase();
  const args = positional.slice(2);

  await ready();

  const client = await connectClient(new OPFSStorageProvider(), { order: opts.order });
  const db = await client.db(dbName);

  try {
    switch (command) {
      case 'collections':
      case 'list': {
        const names = await db.listCollections();
        if (names.length === 0) {
          console.log('No collections.');
          break;
        }
        names.forEach((name, i) => console.log(`${i}: ${name}`));
        break;
      }

      case 'drop-collection': {
        requireArgs(args, 1, 'drop-collection requires <coll>');
        const dropped = await db.dropCollection(args[0]);
        if (dropped) {
          console.log(`Dropped collection ${args[0]}.`);
        } else {
          console.log(`Collection ${args[0]} does not exist; nothing dropped.`);
          process.exitCode = 1;
        }
        break;
      }

      case 'compact': {
        if (args[0]) {
          const coll = await db.collection(args[0]);
          const { generation, bytesBefore, bytesAfter, bytesFreed } = await coll.compact();
          console.log(`Compacted ${args[0]} (generation ${generation}): ${bytesBefore} -> ${bytesAfter} bytes (${bytesFreed} freed).`);
        } else {
          const results = await db.compact();
          const names = Object.keys(results);
          if (names.length === 0) {
            console.log('No collections.');
            break;
          }
          for (const name of names) {
            const r = results[name];
            console.log(`${name}: ${r.bytesBefore} -> ${r.bytesAfter} bytes (${r.bytesFreed} freed, generation ${r.generation})`);
          }
        }
        break;
      }

      case 'insert': {
        requireArgs(args, 2, 'insert requires <coll> and <doc>');
        const coll = await db.collection(args[0]);
        const doc = parseJson('<doc>', args[1]);
        const { insertedId } = await coll.insertOne(doc);
        console.log(`Inserted ${formatValue(insertedId)}.`);
        break;
      }

      case 'insert-many': {
        requireArgs(args, 2, 'insert-many requires <coll> and <docs>');
        const coll = await db.collection(args[0]);
        const docs = parseJson('<docs>', args[1]);
        if (!Array.isArray(docs)) {
          console.error('Error: <docs> must be a JSON array');
          process.exit(1);
        }
        const result = await coll.insertMany(docs, { ordered: opts.ordered !== false });
        console.log(`Inserted ${result.insertedCount} document(s).`);
        break;
      }

      case 'find': {
        requireArgs(args, 1, 'find requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const cursor = coll.find(filter, {
          sort: opts.sort,
          skip: opts.skip,
          limit: opts.limit,
          projection: opts.project
        });
        printDocs(await cursor.toArray());
        break;
      }

      case 'find-one': {
        requireArgs(args, 1, 'find-one requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const doc = await coll.findOne(filter);
        if (doc === null) {
          console.log('No document found.');
          process.exitCode = 1;
        } else {
          console.log(formatValue(doc));
        }
        break;
      }

      case 'count': {
        requireArgs(args, 1, 'count requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        console.log(String(await coll.countDocuments(filter)));
        break;
      }

      case 'distinct': {
        requireArgs(args, 2, 'distinct requires <coll> and <field>');
        const coll = await db.collection(args[0]);
        const filter = args[2] ? parseJson('<filter>', args[2]) : {};
        const values = await coll.distinct(args[1], filter);
        if (values.length === 0) {
          console.log('No values found.');
          break;
        }
        values.forEach((v, i) => console.log(`${i}: ${formatValue(v)}`));
        break;
      }

      case 'delete-one': {
        requireArgs(args, 1, 'delete-one requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const { deletedCount } = await coll.deleteOne(filter);
        if (deletedCount) {
          console.log('Deleted 1 document.');
        } else {
          console.log('No document matched; nothing deleted.');
          process.exitCode = 1;
        }
        break;
      }

      case 'delete-many': {
        requireArgs(args, 1, 'delete-many requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const { deletedCount } = await coll.deleteMany(filter);
        console.log(`Deleted ${deletedCount} document(s).`);
        if (deletedCount === 0) process.exitCode = 1;
        break;
      }

      case 'replace-one': {
        requireArgs(args, 3, 'replace-one requires <coll>, <filter>, and <doc>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const replacement = parseJson('<doc>', args[2]);
        const result = await coll.replaceOne(filter, replacement, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else if (result.modifiedCount) {
          console.log('Replaced 1 document.');
        } else {
          console.log('No document matched; nothing replaced.');
          process.exitCode = 1;
        }
        break;
      }

      case 'update-one': {
        requireArgs(args, 3, 'update-one requires <coll>, <filter>, and <update>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const update = parseJson('<update>', args[2]);
        const result = await coll.updateOne(filter, update, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else if (result.modifiedCount) {
          console.log('Updated 1 document.');
        } else {
          console.log('No document matched; nothing updated.');
          process.exitCode = 1;
        }
        break;
      }

      case 'update-many': {
        requireArgs(args, 3, 'update-many requires <coll>, <filter>, and <update>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const update = parseJson('<update>', args[2]);
        const result = await coll.updateMany(filter, update, { upsert: !!opts.upsert });
        if (result.upsertedId) {
          console.log(`Upserted ${formatValue(result.upsertedId)}.`);
        } else {
          console.log(`Updated ${result.modifiedCount} document(s).`);
          if (result.modifiedCount === 0) process.exitCode = 1;
        }
        break;
      }

      case 'find-one-and-update': {
        requireArgs(args, 3, 'find-one-and-update requires <coll>, <filter>, and <update>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const update = parseJson('<update>', args[2]);
        const doc = await coll.findOneAndUpdate(filter, update, {
          upsert: !!opts.upsert,
          returnDocument: opts.returnDocument || 'before'
        });
        if (doc === null) {
          console.log('No document found.');
          process.exitCode = 1;
        } else {
          console.log(formatValue(doc));
        }
        break;
      }

      case 'find-one-and-replace': {
        requireArgs(args, 3, 'find-one-and-replace requires <coll>, <filter>, and <doc>');
        const coll = await db.collection(args[0]);
        const filter = parseJson('<filter>', args[1]);
        const replacement = parseJson('<doc>', args[2]);
        const doc = await coll.findOneAndReplace(filter, replacement, {
          upsert: !!opts.upsert,
          returnDocument: opts.returnDocument || 'before'
        });
        if (doc === null) {
          console.log('No document found.');
          process.exitCode = 1;
        } else {
          console.log(formatValue(doc));
        }
        break;
      }

      case 'find-one-and-delete': {
        requireArgs(args, 1, 'find-one-and-delete requires <coll>');
        const coll = await db.collection(args[0]);
        const filter = args[1] ? parseJson('<filter>', args[1]) : {};
        const doc = await coll.findOneAndDelete(filter);
        if (doc === null) {
          console.log('No document found.');
          process.exitCode = 1;
        } else {
          console.log(formatValue(doc));
        }
        break;
      }

      case 'bulk-write': {
        requireArgs(args, 2, 'bulk-write requires <coll> and <operations>');
        const coll = await db.collection(args[0]);
        const operations = parseJson('<operations>', args[1]);
        const result = await coll.bulkWrite(operations, { ordered: opts.ordered !== false });
        console.log(formatValue(result));
        break;
      }

      case 'watch': {
        requireArgs(args, 1, 'watch requires <coll>');
        const coll = await db.collection(args[0]);
        const stream = coll.watch();
        console.log(`Watching ${args[0]} for changes... (Ctrl+C to stop)`);
        // A pending ChangeStream promise holds no OS handle (no timer, no
        // socket, no OPFS sync-access-handle I/O), so nothing otherwise
        // keeps the event loop alive between changes. process.stdin.resume()
        // is the usual Node idiom for this but isn't reliable here -- stdin
        // is /dev/null (already at EOF) for any non-interactive invocation
        // (cron, CI, a backgrounded process with no controlling terminal),
        // so an explicit interval is the only deterministic way to hold the
        // loop open regardless of stdin's state.
        const keepAlive = setInterval(() => {}, 1 << 30);
        process.on('SIGINT', async () => {
          clearInterval(keepAlive);
          stream.close();
          await db.close();
          process.exit(0);
        });
        for await (const change of stream) {
          console.log(formatValue(change));
        }
        break;
      }

      case 'create-index': {
        requireArgs(args, 2, 'create-index requires <coll> and <keys>');
        const coll = await db.collection(args[0]);
        const keys = parseJson('<keys>', args[1]);
        const indexOpts = {};
        if (opts.name) indexOpts.name = opts.name;
        if (opts.unique) indexOpts.unique = true;
        if (opts.sparse) indexOpts.sparse = true;
        if (opts.partialFilter) indexOpts.partialFilterExpression = opts.partialFilter;
        if (opts.ttl !== undefined) indexOpts.expireAfterSeconds = opts.ttl;
        const name = await coll.createIndex(keys, indexOpts);
        console.log(`Created index ${name}.`);
        break;
      }

      case 'drop-index': {
        requireArgs(args, 2, 'drop-index requires <coll> and <indexName>');
        const coll = await db.collection(args[0]);
        await coll.dropIndex(args[1]);
        console.log(`Dropped index ${args[1]}.`);
        break;
      }

      case 'list-indexes': {
        requireArgs(args, 1, 'list-indexes requires <coll>');
        const coll = await db.collection(args[0]);
        const indexes = await coll.listIndexes();
        if (indexes.length === 0) {
          console.log('No indexes.');
          break;
        }
        indexes.forEach((ix, i) => console.log(`${i}: ${formatValue(ix)}`));
        break;
      }

      case 'find-by-index': {
        requireArgs(args, 3, 'find-by-index requires <coll>, <indexName>, and <values>');
        const coll = await db.collection(args[0]);
        const values = parseJson('<values>', args[2]);
        printDocs(await coll.findByIndex(args[1], values));
        break;
      }

      case 'prune-expired': {
        requireArgs(args, 1, 'prune-expired requires <coll>');
        const coll = await db.collection(args[0]);
        const deletedCount = await coll.pruneExpired();
        console.log(`Pruned ${deletedCount} expired document(s).`);
        break;
      }

      default:
        console.error(`Error: unknown command '${command}'`);
        usage();
    }

    await client.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (db.isOpen) await client.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
