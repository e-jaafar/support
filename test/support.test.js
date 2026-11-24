import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSupportServer } from '../server.js';

const operatorToken = 'test-operator-token-32-characters-minimum';

async function launch(filename = ':memory:') {
  const server = createSupportServer({ filename, operatorToken });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, { cookie, authorized, body, origin } = {}) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (authorized) headers.Authorization = `Bearer ${operatorToken}`;
      if (origin) headers.Origin = origin;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, {
        headers,
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        value: await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';')[0],
      };
    },
    events: (cookie, signal) => fetch(base + '/api/events', { headers: { Cookie: cookie }, signal }),
    stop() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      return closed;
    },
  };
}

const last = (result) => result.value.messages.at(-1);
const openQueue = { authorized: true };

test('les commandes et la mémoire restent isolées par session', async (t) => {
  const app = await launch();
  t.after(app.stop);
  const a = await app.request('/api/session');
  const b = await app.request('/api/session');
  const { ref } = a.value.orders[0];
  assert.notEqual(a.value.orders[0].ref, b.value.orders[0].ref);
  const send = (cookie, text) => app.request('/api/message', { cookie, body: { text } });
  assert.match(last(await send(a.cookie, 'Je veux suivre ma commande')).text, /Quelle commande/);
  assert.match(last(await send(a.cookie, ref)).text, /En transit/);
  assert.match(last(await send(a.cookie, 'Et elle arrive quand ?')).text, new RegExp(ref));
  assert.match(last(await send(b.cookie, ref)).text, /Je ne trouve pas/);
  assert.match(last(await send(a.cookie, 'Effectue le remboursement maintenant')).text, /traités par l’équipe support/);
  assert.deepEqual((await app.request('/api/operator/tickets', openQueue)).value.tickets, []);
});

test('les garde-fous bloquent les requêtes avant stockage', async (t) => {
  const app = await launch();
  t.after(app.stop);
  const { cookie, value } = await app.request('/api/session');
  const message = (text, origin) => app.request('/api/message', { cookie, origin, body: { text } });
  assert.equal((await message('Carte 4111 1111 1111 1111')).status, 422);
  assert.equal((await message('mot de passe : secret123')).status, 422);
  assert.equal((await message('x'.repeat(801))).status, 400);
  assert.equal((await message('x'.repeat(9000))).status, 413);
  assert.equal((await message('bonjour', 'https://invalide.example')).status, 403);
  assert.equal((await message('bonjour', 'null')).status, 403);
  assert.equal((await app.request('/api/message', { body: { text: 'bonjour' } })).status, 401);
  assert.equal((await app.request('/api/operator/tickets')).status, 401);
  assert.equal((await app.request(`/api/operator/tickets/${value.id}`, openQueue)).status, 404);
  assert.equal((await app.request('/api/handoff', { cookie, body: { confirmed: false } })).status, 400);
  assert.equal((await app.request('/api/session', { cookie })).value.messages.length, 1);
});

test('la reprise humaine arrive en direct et se termine par un retour à l’assistant', async (t) => {
  const app = await launch();
  t.after(app.stop);
  const { cookie, value: { id } } = await app.request('/api/session');
  const ticket = `/api/operator/tickets/${id}`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await app.events(cookie, controller.signal);
  const stream = response.body.getReader();
  const readEvent = async () => new TextDecoder().decode((await stream.read()).value);
  assert.match(await readEvent(), /event: conversation/);
  const handoff = () => app.request('/api/handoff', { cookie, body: { confirmed: true } });
  const sent = await handoff();
  assert.equal(sent.value.status, 'queued');
  assert.match(await readEvent(), new RegExp(`data: ${last(sent).id}\\b`));
  assert.equal(last(await handoff()).id, last(sent).id);
  assert.equal((await app.request('/api/operator/tickets', openQueue)).value.tickets[0].id, id);
  const question = await app.request('/api/message', { cookie, body: { text: 'Mon colis est arrivé abîmé.' } });
  assert.equal(last(question).role, 'client');
  await readEvent();
  const result = await app.request(ticket, { ...openQueue, body: { action: 'reply', text: 'Nous allons examiner votre dossier.' } });
  assert.equal(result.value.status, 'human');
  assert.equal(last(result).role, 'operator');
  assert.match(await readEvent(), new RegExp(`data: ${last(result).id}\\b`));
  assert.equal(last(await app.request('/api/session', { cookie })).text, last(result).text);
  assert.equal((await app.request(ticket, { ...openQueue, body: { action: 'close' } })).value.status, 'closed');
  assert.equal((await app.request(ticket, { ...openQueue, body: { action: 'reply', text: 'Trop tard' } })).status, 409);
  const resumed = await app.request('/api/message', { cookie, body: { text: 'Quels sont les délais de livraison ?' } });
  assert.equal(resumed.value.status, 'assistant');
  assert.match(last(resumed).text, /2 à 4 jours ouvrés/);
  controller.abort();
});

test('historique, commande mémorisée et file survivent à un redémarrage', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'sillage-test-'));
  const file = join(folder, 'support.sqlite');
  let app = await launch(file);
  t.after(async () => {
    await app.stop();
    rmSync(folder, { recursive: true, force: true });
  });
  const { cookie, value } = await app.request('/api/session');
  await app.request('/api/message', { cookie, body: { text: value.orders[1].ref } });
  await app.request('/api/handoff', { cookie, body: { confirmed: true } });
  await app.stop();
  app = await launch(file);
  assert.equal((await app.request('/api/operator/tickets', openQueue)).value.tickets[0].id, value.id);
  await app.request(`/api/operator/tickets/${value.id}`, { ...openQueue, body: { action: 'close' } });
  const continued = await app.request('/api/message', { cookie, body: { text: 'Où est mon colis ?' } });
  assert.match(last(continued).text, new RegExp(value.orders[1].ref));
  assert.equal(continued.value.messages.length, 7);
});
