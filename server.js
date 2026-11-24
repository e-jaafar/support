import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { answer, classifyPolicy, containsSensitiveData, plan } from './assistant.js';
import { openStore } from './store.js';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/operator', ['operator.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/client.js', ['client.js', 'text/javascript']],
  ['/operator.js', ['operator.js', 'text/javascript']],
  ['/ui.js', ['ui.js', 'text/javascript']],
].map(([path, [file, type]]) => [path, [readFileSync(new URL(`./public/${file}`, import.meta.url)), type]]));

const cookieName = 'sillage_session';
const customerRoutes = new Map([
  ['/api/session', 'GET'], ['/api/events', 'GET'], ['/api/message', 'POST'], ['/api/handoff', 'POST'],
]);
const sha256 = (value) => createHash('sha256').update(value).digest();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const { origin, host } = req.headers;
  if (req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
    throw new HttpError(403, 'Origine de la requête refusée.');
  }
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Envoyez un objet JSON.');
  }
  const maxBytes = 8192;
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Objet JSON invalide.');
  }
}

function checkText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 800) throw new HttpError(400, 'Saisissez un message de 1 à 800 caractères.');
  if (containsSensitiveData(text)) throw new HttpError(422, 'Retirez les numéros sensibles ou les identifiants secrets de votre message.');
  return text;
}

export function createSupportServer({ filename, operatorToken, secureCookie = false, apiKey, model = 'gpt-4.1-mini' }) {
  const store = openStore(filename);
  const operatorHash = sha256(`Bearer ${operatorToken}`);
  const listeners = new Map();
  const busy = new Set();
  const creationLimits = new Map();
  let streamCount = 0;

  function publish(id) {
    const subscribers = listeners.get(id);
    const snapshot = store.view(id);
    const event = `event: conversation\ndata: ${snapshot.messages.at(-1).id}\n\n`;
    for (const res of subscribers ?? []) {
      if (!res.write(event)) res.end();
    }
    return snapshot;
  }

  function stream(res, session) {
    const subscribers = listeners.get(session.id) ?? new Set();
    if (subscribers.size >= 4 || streamCount >= 250) throw new HttpError(503, 'Trop de connexions en direct.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: conversation\ndata: ${store.view(session.id).messages.at(-1).id}\n\n`);
    listeners.set(session.id, subscribers);
    subscribers.add(res);
    streamCount++;
    res.on('close', () => {
      subscribers.delete(res);
      streamCount--;
      if (!subscribers.size) listeners.delete(session.id);
    });
  }

  async function route(req, res) {
    const path = (req.url ?? '').split('?')[0];
    const method = req.method;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");

    if (method === 'GET' && files.has(path)) {
      const [content, type] = files.get(path);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(content);
    }

    if (path.startsWith('/api/operator/')) {
      if (!timingSafeEqual(sha256(req.headers.authorization ?? ''), operatorHash)) {
        throw new HttpError(401, 'Jeton opérateur invalide.');
      }
      if (method === 'GET' && path === '/api/operator/tickets') return json(res, { tickets: store.queue() });
      const match = path.match(/^\/api\/operator\/tickets\/([a-f\d-]{36})$/);
      if (!match) throw new HttpError(404, 'Dossier introuvable.');
      const id = match[1];
      const body = method === 'POST' ? await readBody(req) : null;
      const session = store.get(id);
      if (!session || session.status === 'assistant') throw new HttpError(404, 'Dossier introuvable.');
      if (method === 'GET') return json(res, store.view(id));
      if (method !== 'POST') throw new HttpError(405, 'Méthode indisponible.');
      if (body.action === 'reply' && ['queued', 'human'].includes(session.status)) {
        const text = checkText(body.text);
        if (store.counts(id).total >= 500) throw new HttpError(429, 'Ce dossier a atteint la limite de messages.');
        store.change(session, { status: 'human' }, [['operator', text]]);
      } else if (body.action === 'close' && ['queued', 'human'].includes(session.status)) {
        store.change(session, { status: 'closed' }, [['system', 'L’équipe support a clôturé ce dossier. Vous pouvez continuer avec l’assistant.']]);
      } else {
        throw new HttpError(409, 'Cette action est indisponible pour ce dossier.');
      }
      return json(res, publish(id));
    }

    if (!customerRoutes.has(path)) throw new HttpError(404, 'Page introuvable.');
    if (method !== customerRoutes.get(path)) throw new HttpError(405, 'Méthode indisponible.');
    const token = (req.headers.cookie ?? '').match(/(?:^|;\s*)sillage_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    let session = token && store.fromToken(token);
    if (path === '/api/session') {
      if (!session) {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Origine de la requête refusée.');
        const now = Date.now();
        const address = req.socket.remoteAddress;
        const entry = creationLimits.get(address);
        const limit = entry?.until > now ? entry : { count: 0, until: now + 60_000 };
        if (limit.count >= 12 || (!entry && creationLimits.size >= 10_000)) {
          throw new HttpError(429, 'Trop de nouvelles sessions. Réessayez dans une minute.');
        }
        limit.count++;
        creationLimits.set(address, limit);
        const created = store.create();
        session = created.session;
        res.setHeader('Set-Cookie', `${cookieName}=${created.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}`);
      }
      return json(res, { ...store.view(session.id), orders: store.orders(session.id), aiEnabled: Boolean(apiKey) });
    }

    if (!session) throw new HttpError(401, 'Session expirée. Actualisez la page.');
    if (path === '/api/events') return stream(res, session);

    const body = await readBody(req);
    session = store.get(session.id);
    if (!session) throw new HttpError(401, 'Session expirée. Actualisez la page.');
    const id = session.id;
    if (path === '/api/handoff') {
      if (body.confirmed !== true) throw new HttpError(400, 'Confirmez le partage avec l’équipe support.');
      if (session.status === 'queued' || session.status === 'human') return json(res, store.view(id));
      if (store.counts(id).total >= 500) throw new HttpError(429, 'Ce dossier a atteint la limite de messages.');
      store.change(session, { status: 'queued' }, [['system', 'Conversation transmise à l’équipe support. Vous pouvez ajouter des détails ici en attendant une réponse.']]);
      return json(res, publish(id));
    }

    const text = checkText(body.text);
    const counts = store.counts(id);
    if (counts.recent >= 20 || counts.sent >= 200 || counts.total >= 499) throw new HttpError(429, 'Limite de messages atteinte.');
    if (busy.has(id)) throw new HttpError(409, 'Un message est déjà en cours de traitement.');

    const isAssistant = ({ status }) => status === 'assistant' || status === 'closed';
    let route = isAssistant(session) ? plan(text, session) : null;
    if (!route && apiKey && isAssistant(session) && !/[@\d]/u.test(text)) {
      busy.add(id);
      try {
        route = await classifyPolicy(text, apiKey, model);
      } finally {
        busy.delete(id);
      }
      session = store.get(id);
      if (!session) throw new HttpError(401, 'Session expirée. Actualisez la page.');
    }
    const entries = [['client', text]];
    let changes = {};
    if (isAssistant(session)) {
      const { reply, ...memory } = answer(route, store, session);
      changes = { ...memory, status: 'assistant' };
      entries.push(['assistant', reply]);
    }
    store.change(session, changes, entries);
    return json(res, publish(id));
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    route(req, res).catch((error) => {
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader('Connection', 'close');
        return json(res, { error: error.message }, error.status);
      }
      console.error('Erreur interne', error.code ?? error.name);
      if (!res.headersSent) return json(res, { error: 'Le service est momentanément indisponible.' }, 500);
      res.end();
    });
  });

  store.prune();
  const timer = setInterval(() => {
    const now = Date.now();
    store.prune();
    for (const [address, limit] of creationLimits) {
      if (limit.until <= now) creationLimits.delete(address);
    }
    for (const [id, subscribers] of listeners) {
      const exists = store.get(id);
      for (const res of subscribers) {
        if (!exists || !res.write(': heartbeat\n\n')) res.end();
      }
    }
  }, 20_000).unref();
  server.on('close', () => {
    clearInterval(timer);
    store.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { HOST = '127.0.0.1', PORT = 3000, SUPPORT_DB = 'data/support.sqlite', NODE_ENV, OPENAI_API_KEY, OPENAI_MODEL } = process.env;
  const secureCookie = NODE_ENV === 'production';
  const token = process.env.OPERATOR_TOKEN ?? (secureCookie ? '' : randomBytes(24).toString('base64url'));
  if (token.length < 32 || !/^[\x21-\x7E]+$/.test(token)) throw new Error('OPERATOR_TOKEN doit contenir au moins 32 caractères ASCII imprimables, sans espaces.');
  mkdirSync(dirname(SUPPORT_DB), { recursive: true, mode: 0o700 });
  const server = createSupportServer({ filename: SUPPORT_DB, operatorToken: token, secureCookie, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
  server.listen(Number(PORT), HOST, () => {
    console.log(`Sillage écoute sur ${HOST}:${server.address().port}`);
    if (!process.env.OPERATOR_TOKEN) console.log(`Jeton opérateur temporaire : ${token}`);
  });
}
