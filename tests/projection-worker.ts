import { readFile } from "node:fs/promises";
import { Books } from "../server/books";
import { parseManifest } from "../src/lib/deployment";
import { record, text, array } from "../src/lib/boundary";
import { parseRawBlock } from "../server/chain";
const input = record(JSON.parse(await readFile(process.argv[2], "utf8"))),
  books = new Books(text(input.path), parseManifest(input.manifest));
try {
  const blocks = array(input.blocks).map(parseRawBlock);
  for (let i = 0; i < 20; i++) {
    for (const b of [...blocks].reverse()) books.capture(b);
    books.project();
  }
  console.log(books.digest());
} finally {
  books.close();
}
