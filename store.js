import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const digest = (token) => createHash('sha256').update(token).digest('hex');

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'assistant' CHECK (status IN ('assistant', 'queued', 'human', 'closed')),
      last_order TEXT,
      awaiting_order INTEGER NOT NULL DEFAULT 0,
      touched INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS orders (
      ref TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      product TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('assistant', 'client', 'operator', 'system')),
      text TEXT NOT NULL,
      created INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS orders_by_session ON orders(session_id);
  `);

  const sessionById = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const sessionByToken = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const insertSession = db.prepare('INSERT INTO sessions (id, token_hash, touched) VALUES (?, ?, ?)');
  const insertOrder = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)');
  const orders = db.prepare('SELECT ref, product, status FROM orders WHERE session_id = ? ORDER BY ref');
  const order = db.prepare('SELECT ref, product, status FROM orders WHERE session_id = ? AND ref = ?');
  const messages = db.prepare('SELECT id, role, text, created FROM messages WHERE session_id = ? ORDER BY id');
  const append = db.prepare('INSERT INTO messages (session_id, role, text, created) VALUES (?, ?, ?, ?)');
  const update = db.prepare('UPDATE sessions SET status = ?, last_order = ?, awaiting_order = ?, touched = ? WHERE id = ?');
  const counts = db.prepare(`
    SELECT count(*) AS total, sum(role = 'client') AS sent,
      sum(role = 'client' AND created >= ?) AS recent
    FROM messages WHERE session_id = ?
  `);
  const queue = db.prepare(`
    SELECT id, status, touched, (
      SELECT text FROM messages WHERE session_id = sessions.id AND role = 'client' ORDER BY id DESC LIMIT 1
    ) AS preview
    FROM sessions WHERE status IN ('queued', 'human')
    ORDER BY status = 'queued' DESC, touched DESC LIMIT 100
  `);
  const prune = db.prepare('DELETE FROM sessions WHERE touched < ?');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    create() {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      transaction(() => {
        insertSession.run(id, digest(token), Date.now());
        insertOrder.run(`SL-${id.slice(0, 8).toUpperCase()}X${id.slice(9, 13).toUpperCase()}`, id, 'Carnet Rivage', 'En transit');
        insertOrder.run(`SL-${id.slice(0, 8).toUpperCase()}Y${id.slice(9, 13).toUpperCase()}`, id, 'Sac Atelier', 'Livrée');
        append.run(id, 'assistant', 'Bonjour ! Je suis l’assistant de Sillage. Je peux suivre une commande ou vous renseigner sur les livraisons et les retours.', Date.now());
      });
      return { session: sessionById.get(id), token };
    },
    fromToken: (token) => sessionByToken.get(digest(token)),
    get: (id) => sessionById.get(id),
    order: (id, ref) => order.get(id, ref),
    orders: (id) => orders.all(id),
    view(id) {
      const { status } = sessionById.get(id);
      return { id, status, messages: messages.all(id) };
    },
    queue: () => queue.all(),
    counts: (id) => counts.get(Date.now() - 60_000, id),
    change(session, changes, entries) {
      transaction(() => {
        const now = Date.now();
        const next = { ...session, ...changes };
        update.run(next.status, next.last_order, next.awaiting_order, now, session.id);
        for (const [role, text] of entries) append.run(session.id, role, text, now);
      });
    },
    prune: () => prune.run(Date.now() - 7 * 24 * 60 * 60 * 1000),
    close: () => db.close(),
  };
}
